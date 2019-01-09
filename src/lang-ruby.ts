import * as sourcegraph from 'sourcegraph'
import Sorbet from './sorbet-wasm.js'

interface SorbetConnection {
    typecheck: (fileContent: string) => Promise<void>
    send: (message: string) => void
}

interface MkConnectionArgs {
    wasmURL: string
    receive: (message: string) => void
}

async function mkConnection({ wasmURL, receive: onResponse }: MkConnectionArgs): Promise<SorbetConnection> {
    const sorbetWasm = await fetch(wasmURL)
        .then(response => response.arrayBuffer())
        .then(bytes => WebAssembly.compile(bytes))

    const Module = Sorbet({
        // https://kripken.github.io/emscripten-site/docs/api_reference/module.html#Module.instantiateWasm
        instantiateWasm: (info, success) => {
            WebAssembly.instantiate(sorbetWasm, info)
                .then(instance => success(instance, sorbetWasm))
                .catch(error => console.log(error))
            return {} // indicates async loading
        },
    })

    const moduleOnResponse = Module.addFunction(response => {
        onResponse(Module.Pointer_stringify(response))
    }, 'vi')

    const loop = Module.ccall('lsp_initialize', 'number', ['number'], [moduleOnResponse])

    return {
        typecheck: fileContent => Module.ccall('typecheck', null, ['string'], [fileContent]),
        send: message => Module.ccall('lsp_send', null, ['number', 'string'], [loop, message]),
    }
}

export function activate(): void {
    sourcegraph.languages.registerHoverProvider(['*'], {
        provideHover: async (doc, position) => {
            const sorbet = await mkConnection({
                wasmURL: 'http://localhost:5000/sorbet-wasm.wasm',
                receive: console.log,
            })
            console.log('typecheckng...')
            sorbet.typecheck(doc.text)
            console.log('sending...')
            sorbet.send('hey')

            return { contents: { value: `Hi from Sorbet` } }
        },
    })
}
