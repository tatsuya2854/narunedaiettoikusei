// three の GLTFExporter を Node で動かすための最小の下ごしらえ（FileReader だけ無い）
if (typeof globalThis.FileReader === "undefined") {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) { blob.arrayBuffer().then((b) => { this.result = b; this.onloadend?.(); this.onload?.({ target: this }); }); }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((b) => {
        this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(b).toString("base64")}`;
        this.onloadend?.(); this.onload?.({ target: this });
      });
    }
  };
}
