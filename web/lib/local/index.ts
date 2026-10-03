// PLACEHOLDER (survivor flow branch). The local-first module owns this file; at merge its
// implementation replaces this one entirely. Until then the flow runs on the thin mocks.
import type { BillReader, Classifier, StatementParser } from "../contracts";
import { mockBillReader, mockClassifier, mockStatementParser } from "../mocks";

export const statementParser: StatementParser = mockStatementParser;
export const classifier: Classifier = mockClassifier;
export const billReader: BillReader = mockBillReader();
