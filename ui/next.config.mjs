import { join } from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The Midnight SDK reaches for Node built-ins that webpack does not polyfill
  // on its own. Without these the client bundle fails with "isomorphic-ws not
  // found" and "pipeline is not a function".
  webpack: (config, { isServer, webpack }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        child_process: false,
        crypto: false,
        stream: 'stream-browserify',
      };
      // isomorphic-ws only exports WebSocket from its Node build; the browser
      // has it natively. See lib/isomorphic-ws-fix.mjs.
      config.resolve.alias = {
        ...config.resolve.alias,
        'isomorphic-ws': join(process.cwd(), 'lib/isomorphic-ws-fix.mjs'),
      };
      // compact-runtime's fromHex/toHex use the Node global Buffer without
      // importing it. Webpack 5 no longer provides it, and nothing fails until
      // a contract call is under way, so the browser-side proof is the first
      // thing to hit it.
      config.plugins.push(new webpack.ProvidePlugin({ Buffer: ['buffer', 'Buffer'] }));
    }
    config.experiments = { ...config.experiments, asyncWebAssembly: true, topLevelAwait: true };
    return config;
  },
  // WASM-backed SDK packages must stay external to the server bundle.
  serverExternalPackages: [
    '@midnight-ntwrk/compact-runtime',
    '@midnight-ntwrk/onchain-runtime-v3',
    '@midnight-ntwrk/midnight-js-network-id',
  ],
  // Static generation tries to resolve the SDK's Node dependencies and hangs.
  images: { unoptimized: true },
  // The compiled contract lives outside ui/, at the repository root.
  outputFileTracingRoot: new URL('..', import.meta.url).pathname,
};

export default nextConfig;
