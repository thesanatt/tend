// On-device intelligence: statement parsing, transaction sorting, and bill reading, all in the
// browser (docs/PRIVACY.md). Cloud AI runs only when the caller passes the survivor's consent.
//
//   const { txns, warnings } = await statementParser.parse(file);          // CSV, OFX/QFX, or PDF
//   const bank = await statementParser.fetchNessie("rowan-mi");            // demo bank, via the relay
//   const items = await classifier.classify(txns, { st, incident_date });  // ClassifiedItem[] for the engine
//   const bill = await billReader.read(file);                              // "ok" only when lines add up
//
// classifier.classifyDetailed returns the same items plus every row's label and what ran where.
// Pass { cloudConsent: true } to classify or billReader.read only after the consent screen.
// deviceAiStatus() says whether Gemini Nano is ready; startModelDownload() must be called straight
// from a tap or key press, classifier.prewarm() loads a ready model early, and releaseDeviceAi()
// closes the model's sessions (for Quick exit).
// For a bank bill the relay marks itemized, read its document (bank.documents[i].path) with
// billReader and pass { anchors: [{ date: reading.service_date, ref: item_id, expense: "medical" }] }
// to classify, so a ride that day links to care.
export { statementParser, parseStatementBytes, parseStatementText } from "./statement";
export { classifier, classifyDetailed, SYSTEM_PROMPT } from "./classify";
export { billReader, readBill } from "./bill";
export { deviceAiStatus, startModelDownload, downloadProgress, forgetSessions as releaseDeviceAi } from "./deviceai";
export { fetchNessie, fromNessieRelay } from "./nessie";
export { inferPayDips } from "./paydip";
export { measureDeviceClassifier } from "./measure";
export type {
  ClassifyContext,
  ClassifyOptions,
  ClassifyReport,
  LocalBillLine,
  LocalBillReader,
  LocalBillReading,
  LocalClassifiedItem,
  LocalClassifier,
  LocalStatementParser,
  LocalTxn,
  NessieResult,
  StatementResult,
  TxnKind,
} from "./types";
