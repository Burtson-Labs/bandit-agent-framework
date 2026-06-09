// Empty stub for `react-devtools-core`. ink statically imports this
// module at the top of its devtools.js but only invokes it when the
// user has react-devtools running on ws://localhost:8097. Since the
// bandit CLI never spins up devtools, the import is a dead reference;
// pointing esbuild's alias here keeps the bundle resolvable without
// shipping the devtools tree.
export default {
  connectToDevTools() {
    // intentional no-op
  }
};
