import { defineConfig } from 'tsdown'
const external = ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-primitives']
export default defineConfig({
 entry: { client: 'src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser',
 dts: false, sourcemap: true, clean: false, external,
 noExternal: id => external.includes(id) ? undefined : true,
 define: { 'process.env.NODE_ENV': JSON.stringify('production') },
 outputOptions: {
  entryFileNames: 'client.js',
  banner: 'window.__ModuleLoader__.load({ id: "dsh-plugin-magpie", factory: (require) => {',
  footer: 'return module.exports; } });',
  intro: 'var module = { exports: {} }; var exports = module.exports;'
 }
})
