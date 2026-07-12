class QigouSpatialDesigner extends HTMLElement {
  static get observedAttributes() { return ["src", "tenant-id", "project-id", "theme", "height"]; }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.handleMessage = this.handleMessage.bind(this);
  }

  connectedCallback() {
    this.render();
    window.addEventListener("message", this.handleMessage);
  }

  disconnectedCallback() {
    window.removeEventListener("message", this.handleMessage);
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  render() {
    const source = this.getAttribute("src") || "https://YOUR-DOMAIN.example";
    const height = this.getAttribute("height") || "760px";
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; width: 100%; }
        iframe { display: block; width: 100%; height: ${height}; border: 0; border-radius: 16px; background: #efede6; }
      </style>
      <iframe title="栖构 AI 空间设计总监" allow="camera; clipboard-write" loading="lazy" src="${source}"></iframe>`;
    this.frame = this.shadowRoot.querySelector("iframe");
    this.frame.addEventListener("load", () => this.setContext());
  }

  setContext(extra = {}) {
    this.frame?.contentWindow?.postMessage({
      type: "qigou:set-context",
      detail: {
        tenantId: this.getAttribute("tenant-id") || null,
        projectId: this.getAttribute("project-id") || null,
        theme: this.getAttribute("theme") || "auto",
        ...extra
      }
    }, "*");
  }

  getState() {
    this.frame?.contentWindow?.postMessage({ type: "qigou:get-state" }, "*");
  }

  reset() {
    this.frame?.contentWindow?.postMessage({ type: "qigou:reset" }, "*");
  }

  handleMessage(event) {
    if (event.source !== this.frame?.contentWindow || !event.data?.type?.startsWith("qigou:")) return;
    const name = event.data.type.slice(7);
    this.dispatchEvent(new CustomEvent(name, { detail: event.data.detail, bubbles: true, composed: true }));
  }
}

if (!customElements.get("qigou-spatial-designer")) {
  customElements.define("qigou-spatial-designer", QigouSpatialDesigner);
}
