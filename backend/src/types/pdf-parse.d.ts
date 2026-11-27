declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfPage {
    getTextContent(): Promise<{ items: { str: string; transform: number[] }[] }>;
  }
  const parse: (input: Buffer | { data: Uint8Array; isEvalSupported?: boolean; stopAtErrors?: boolean }, options?: { max?: number; pagerender?: (page: PdfPage) => Promise<string> }) => Promise<{ text: string; numpages: number }>;
  export default parse;
}

declare module 'pdf-parse' {
  export { default } from 'pdf-parse/lib/pdf-parse.js';
}
