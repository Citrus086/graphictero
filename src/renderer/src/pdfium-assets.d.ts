/** EmbedPDF 的 pdfium wasm 以 vite asset URL 引入（electron-vite 拷到产物目录） */
declare module '@embedpdf/pdfium/pdfium.wasm?url' {
  const src: string
  export default src
}
