/**
 * Browser shim for `isomorphic-ws`.
 *
 * The indexer provider imports a named `WebSocket` from isomorphic-ws, which
 * that package only exposes in its Node build — in the browser bundle webpack
 * reports "'WebSocket' is not exported from 'isomorphic-ws'" and the build
 * fails. Browsers have WebSocket natively, so aliasing the package to this
 * file gives webpack both the default and the named export it is looking for.
 */
export default globalThis.WebSocket;
export const WebSocket = globalThis.WebSocket;
