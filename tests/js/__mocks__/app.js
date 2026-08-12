// Minimal stub of ComfyUI's scripts/app.js for the Vitest harness.
// Extension-module tests import `app` without a real frontend.
export const app = {
  // Every object the pack registers, in order. The extension object is the
  // pack's whole contract with the app chrome (commands / menuCommands /
  // actionBarButtons / setup), and it is assembled by spreading two kit
  // helpers — a spread that silently wins a key it should not own produces a
  // registration that still LOOKS fine. Recording it is what lets a test read
  // the assembled result back.
  registrations: [],
  registerExtension(ext) {
    this.registrations.push(ext);
  },
  graph: { _nodes: [] },
  // ComfyUI's ComfyApi is an EventTarget hanging off app.api, and the `executed`
  // websocket message reaches extensions as a CustomEvent dispatched there
  // (api.ts:743-749 -> dispatchCustomEvent(msg.type, msg.data)). A real one
  // lands HERE, so the scan-warm suite dispatches here rather than on document —
  // an event dispatched somewhere a real one never arrives asserts nothing.
  api: new EventTarget(),
  // loadWorkflow() hands a File to the app's own loader. Recording the calls
  // lets a test assert the pack delegates rather than parsing graphs itself.
  handleFileCalls: [],
  async handleFile(file) {
    this.handleFileCalls.push(file);
  },
};
