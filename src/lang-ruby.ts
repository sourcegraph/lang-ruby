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
} from 'vscode-jsonrpc'
import {
    HoverRequest,
    InitializedNotification,
    InitializeError,
    InitializeParams,
    InitializeRequest,
    InitializeResult,
    DidOpenTextDocumentParams,
} from 'vscode-languageserver-protocol'
import Sorbet from './sorbet-wasm.js'
import { AbstractMessageReader, DataCallback } from 'vscode-jsonrpc/lib/messageReader'
import { AbstractMessageWriter } from 'vscode-jsonrpc/lib/messageWriter'

type FunctionHandle = undefined

interface ModulePatch {
    addFunction: (f: any, signature: string) => FunctionHandle
}

type SendReceive = (receive: (message: string) => void) => ((message: string) => any)

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

        const lspLoop = wasmModule.ccall('lsp_initialize', 'number', ['number'], [moduleOnResponse])

        return message => {
            wasmModule.ccall('lsp_send', null, ['number', 'string'], [lspLoop, message])
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

export function activate(): void {
    async function main(): Promise<void> {
        const sendReceive = await connect('http://localhost:5000/sorbet-wasm.wasm')
        // const { reader, writer } = sendReceiveMessageTransports(sendReceive)
        const { reader, writer } = sendReceiveMSGMessageTransports(sendReceive)
        const connection = createMessageConnection(reader, writer)
        connection.trace(Trace.Verbose, { log: console.log })
        connection.listen()
        await connection.sendRequest(InitializeRequest.type, {
            rootUri: 'file:///',
            rootPath: '/',
            processId: null,
            capabilities: {},
            workspaceFolders: [],
        })
        connection.sendNotification(InitializedNotification.type, {})

        sourcegraph.languages.registerHoverProvider(['*'], {
            provideHover: async (doc, position) => {
                connection.sendNotification(
                    new NotificationType<DidOpenTextDocumentParams, void>('textDocument/didOpen'),
                    {
                        textDocument: {
                            uri: 'file:///sample.rb',
                            languageId: 'ruby',
                            version: 1,
                            text: doc.text,
                        },
                    }
                )
                const result = await connection.sendRequest(HoverRequest.type, {
                    textDocument: { uri: 'file:///sample.rb' },
                    position: { line: position.line, character: position.character },
                })

                return result
            },
        })
    }
    main()
}
