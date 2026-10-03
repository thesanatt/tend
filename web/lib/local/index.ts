// On-device intelligence: statement parsing, transaction sorting, and bill reading, all in the
// browser (docs/PRIVACY.md). Cloud AI runs only when the caller passes the survivor's consent.
export { statementParser, parseStatementBytes, parseStatementText } from "./statement";
export { classifier, classifyDetailed, SYSTEM_PROMPT } from "./classify";
export { billReader, readBill } from "./bill";
export { deviceAiStatus, startModelDownload, downloadProgress } from "./deviceai";
export { fetchNessie, fromNessieRelay } from "./nessie";
export { inferPayDips } from "./paydip";
export type {
  ClassifyContext,
  ClassifyOptions,
  ClassifyReport,
  LocalBillLine,
  LocalBillReading,
  LocalClassifiedItem,
  LocalTxn,
  NessieResult,
  StatementResult,
  TxnKind,
} from "./types";
