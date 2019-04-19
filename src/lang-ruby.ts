import * as lsp from 'vscode-languageserver-protocol'
import * as sourcegraph from 'sourcegraph'
import {
    createMessageConnection,
    MessageReader,
    MessageWriter,
    NotificationType,
    StreamMessageReader,
    StreamMessageWriter,
    RequestType,
    Message,
    Trace,
    MessageConnection,
} from 'vscode-jsonrpc'
import {
    HoverRequest,
    InitializedNotification,
    InitializeError,
    InitializeParams,
    InitializeRequest,
    InitializeResult,
    DidOpenTextDocumentParams,
    DefinitionRequest,
} from 'vscode-languageserver-protocol'
import Sorbet from './sorbet-wasm.js'
import { AbstractMessageReader, DataCallback } from 'vscode-jsonrpc/lib/messageReader'
import { AbstractMessageWriter } from 'vscode-jsonrpc/lib/messageWriter'
import * as convert from './convert-lsp-to-sea'

type FunctionHandle = undefined

interface ModulePatch {
    addFunction: (f: any, signature: string) => FunctionHandle
}

type SendReceive = (receive: (message: string) => void) => (message: string) => any

async function connect(wasmURL: string): Promise<SendReceive> {
    const sorbetWasm = await fetch(wasmURL)
        .then(response => response.arrayBuffer())
        .then(bytes => WebAssembly.compile(bytes))

    // TODO try to avoid the `let`/`Promise` gymnastics here. It hangs if you `resolve(wasmModule)`.
    let wasmModule: (typeof Module) & ModulePatch = undefined as any
    await new Promise(resolve => {
        wasmModule = Sorbet({
            // https://kripken.github.io/emscripten-site/docs/api_reference/module.html#Module.instantiateWasm
            instantiateWasm: (info, success) => {
                WebAssembly.instantiate(sorbetWasm, info)
                    .then(instance => success(instance, sorbetWasm))
                    .catch(error => console.log(error))
                return {} // indicates async loading
            },
            onRuntimeInitialized: resolve,
        })
    })

    return receive => {
        const moduleOnResponse = wasmModule.addFunction(response => {
            receive(wasmModule.Pointer_stringify(response))
        }, 'vi')

        return message => {
            wasmModule.ccall('lsp', null, ['number', 'string'], [moduleOnResponse, message])
        }
    }
}

class ReceiveMessageReader extends StreamMessageReader {
    constructor(ref: { receive: (message: string) => void }, encoding = 'utf-8') {
        super(
            // Hack
            // tslint:disable-next-line:no-object-literal-type-assertion
            {
                on: (event, listener) => {
                    if (event === 'data') {
                        ref.receive = listener
                    }
                },
            } as NodeJS.ReadableStream,
            encoding
        )
    }
}

class SendMessageWriter extends StreamMessageWriter {
    constructor(send: (message: string) => void, encoding = 'utf-8') {
        super(
            // Hack
            // tslint:disable-next-line:no-object-literal-type-assertion
            {
                write: (message, encoding) => {
                    send(message)
                    return true
                },
                on: (event, listener) => {
                    // TODO support 'close' and 'error'
                },
            } as NodeJS.WritableStream,
            encoding
        )
    }
}

class ReceiveMSGMessageReader extends AbstractMessageReader {
    constructor(private ref: { receive: (message: string) => void }) {
        super()
    }

    public listen(callback: DataCallback): void {
        this.ref.receive = message => callback(JSON.parse(message))
    }
}

class SendMSGMessageWriter extends AbstractMessageWriter {
    constructor(private send: (message: string) => void, encoding = 'utf-8') {
        super()
    }
    public write(message: Message): void {
        this.send(JSON.stringify(message))
    }
}

interface MessageTransports {
    reader: MessageReader
    writer: MessageWriter
    detached?: boolean
}

function sendReceiveMessageTransports(sr: SendReceive): MessageTransports {
    // tslint:disable-next-line:no-empty
    const ref = { receive: (message: string) => {} }
    const send = sr(message => ref.receive(message))
    return {
        reader: new ReceiveMessageReader(ref),
        writer: new SendMessageWriter(send),
    }
}

function sendReceiveMSGMessageTransports(sr: SendReceive): MessageTransports {
    // tslint:disable-next-line:no-empty
    const ref = { receive: (message: string) => {} }
    const send = sr(message => ref.receive(message))
    return {
        reader: new ReceiveMSGMessageReader(ref),
        writer: new SendMSGMessageWriter(send),
    }
}

async function queryGraphQL(query: string, variables: any = {}): Promise<any> {
    const { data, errors } = await sourcegraph.commands.executeCommand('queryGraphQL', query, variables)
    if (errors) {
        throw Object.assign(new Error(errors.map((err: any) => err.message).join('\n')), { errors })
    }
    return data
}

interface GraphQLFileRseponse {
    repository: {
        commit: {
            file: { content: string }
        }
    }
    errors: { message: string }[]
}

async function fetchFileContent(args: { cloneURL: string; revision: string; filePath: string }): Promise<string> {
    const response = (await queryGraphQL(
        `
query($cloneURL: String!, $revision: String!, $filePath: String!) {
  repository(cloneURL: $cloneURL) {
    name
    commit(rev: $revision) {
      file(path: $filePath) {
        content
      }
    }
  }
}
	`,
        args
    )) as GraphQLFileRseponse

    if (
        !response ||
        !response.repository ||
        !response.repository.commit ||
        !response.repository.commit.file ||
        !response.repository.commit.file.content
    ) {
        throw new Error(
            [
                'Could not find file content on Sourcegraph. Make sure your Sourcegraph instance has enabled and cloned the repository.',
                JSON.stringify({ ...args, sourcegraphURL: sourcegraph.internal.sourcegraphURL }),
                ...(response.errors ? response.errors.map(error => error.message).join('\n') : []),
            ].join('\n')
        )
    }

    return response.repository.commit.file.content
}

async function getDocFileContent(doc: sourcegraph.TextDocument): Promise<string> {
    const url = new URL(doc.uri)
    const revision = url.search.slice(1) // drop the ?
    const filePath = url.hash.slice(1) // drop the #
    url.search = ''
    url.hash = ''
    const cloneURL = url.href
    const content = await fetchFileContent({
        cloneURL,
        filePath,
        revision,
    })
    return content
}

function lsURI(sgURI: string): string {
    return `file:///${new URL(sgURI).hash.slice(1)}`
}

function positionParams(doc: sourcegraph.TextDocument, pos: sourcegraph.Position): lsp.TextDocumentPositionParams {
    return {
        textDocument: {
            uri: lsURI(doc.uri),
        },
        position: {
            line: pos.line,
            character: pos.character,
        },
    }
}

async function opened(doc: sourcegraph.TextDocument, connection: MessageConnection): Promise<void> {
    const content = await getDocFileContent(doc)
    connection.sendNotification(new NotificationType<DidOpenTextDocumentParams, void>('textDocument/didOpen'), {
        textDocument: {
            uri: lsURI(doc.uri),
            languageId: 'ruby',
            version: 1,
            text: content,
        },
    })
}

export function activate(): void {
    async function main(): Promise<void> {
        const sendReceive = await connect('http://localhost:5000/sorbet-wasm.wasm')
        // const { reader, writer } = sendReceiveMessageTransports(sendReceive)
        const { reader, writer } = sendReceiveMSGMessageTransports(sendReceive)
        const connection = createMessageConnection(reader, writer)
        connection.trace(Trace.Verbose, { log: console.log })
        connection.listen()
        await connection.sendRequest(InitializeRequest.type, {
            rootUri: 'file://',
            rootPath: '/',
            processId: null,
            capabilities: {},
            workspaceFolders: [],
        })
        connection.sendNotification(InitializedNotification.type, {})

        sourcegraph.languages.registerHoverProvider([{ pattern: '*.rb' }], {
            provideHover: async (doc, position) => {
                await opened(doc, connection)

                const result = await connection.sendRequest(HoverRequest.type, positionParams(doc, position))

                return result as sourcegraph.Hover
            },
        })

        sourcegraph.languages.registerDefinitionProvider(['*'], {
            provideDefinition: async (doc, position) => {
                await opened(doc, connection)

                const result = await connection.sendRequest(DefinitionRequest.type, positionParams(doc, position))

                type Definition = lsp.Location | lsp.Location[] | null

                return convert.definition({ currentDocURI: doc.uri, definition: result as Definition })
            },
        })
    }
    main()
}
