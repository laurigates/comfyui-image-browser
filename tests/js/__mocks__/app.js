// Minimal stub of ComfyUI's scripts/app.js for the Vitest harness.
// Extension-module tests import `app` without a real frontend.
export const app = {
  registerExtension() {},
  graph: { _nodes: [] },
  // loadWorkflow() hands a File to the app's own loader. Recording the calls
  // lets a test assert the pack delegates rather than parsing graphs itself.
  handleFileCalls: [],
  async handleFile(file) {
    this.handleFileCalls.push(file);
  },
};
