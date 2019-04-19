# Ruby language extension

Ruby code intelligence.

## Prerequisites

Sourcegraph extensions are written in TypeScript and are distributed as bundled JavaScript files that run on the client. For creation, publishing, and viewing, you need:

- **Creation**: Install [Node.js](https://nodejs.org).
- **Publishing**: Install the [Sourcegraph CLI (`src`)](https://github.com/sourcegraph/src-cli#installation) and create a [Sourcegraph.com account](https://sourcegraph.com/sign-up).
- **Viewing**: Install the Sourcegraph extension for [Chrome](https://chrome.google.com/webstore/detail/sourcegraph/dgjhfomjieaadpoljlnidmbgkdffpack) or [Firefox](https://addons.mozilla.org/en-US/firefox/addon/sourcegraph/).

## Set up

```
npm install
```

## Lint and type check

```
npm run tslint
npm run typecheck
```

## Publish

```
src extensions publish
```

## Sourecgraph extension API

Visit the [Sourcegraph extension documentation](https://github.com/sourcegraph/sourcegraph-extension-docs) and check out some [Sourcegraph extension samples](https://github.com/sourcegraph/sourcegraph-extension-samples).

## Building and running

```bash
# Build the .wasm and .js files
$ bazel build //emscripten:sorbet-wasm.tar --config=webasm-darwin && \
  tar -xvf ./bazel-bin/emscripten/sorbet-wasm.tar sorbet-wasm.wasm sorbet-wasm.js
# Serve the .wasm and .js files
$ http-server --cors -p 5000 .
# Serve the extension
$ yarn run serve
```

Open https://sourcegraph.com/github.com/sourcegraph/lang-ruby@master/-/blob/sample.rb?diff=d533cd6aa770e09274fa9f427d81d2f57c2a6858

Sideload the extension.

You should see hover tooltips:

![image](https://user-images.githubusercontent.com/1387653/56444171-7cd8f100-62ac-11e9-9639-fccb96d0e787.png)
