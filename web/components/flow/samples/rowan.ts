// Fictional demo data for the survivor flow: Rowan, a made-up person with a made-up bank history.
// Generated from seed/snapshots/rowan-mi.json (transactions) and seed/bills/rowan-mi-riverbend.pdf
// (sha256 231c5c86178943f9b448534a0dd3f8232bcfa61d2a66d63c45c8856c333d9104). No real person, account, or hospital.

// [date, kind, amount in cents, merchant, description]
export type SampleRow = [string, string, number, string, string];

export const ROWAN_ROWS: SampleRow[] = [
  ["2026-04-01", "purchase", 1900, "Larkfield Market", "groceries"],
  ["2026-04-03", "deposit", 41200, "", "Fernway Books payroll"],
  ["2026-04-03", "transfer", 4000, "", "Save to Cushion"],
  ["2026-04-04", "purchase", 900, "Wayfare Rides", "trip"],
  ["2026-04-04", "withdrawal", 6000, "", "ATM withdrawal"],
  ["2026-04-05", "purchase", 5100, "Larkfield Market", "groceries"],
  ["2026-04-06", "purchase", 500, "Copper Kettle Coffee", "coffee"],
  ["2026-04-07", "purchase", 900, "Copper Kettle Coffee", "coffee"],
  ["2026-04-08", "purchase", 7300, "Larkfield Market", "groceries"],
  ["2026-04-09", "purchase", 800, "Copper Kettle Coffee", "coffee"],
  ["2026-04-09", "purchase", 1200, "Lumen Streaming", "monthly subscription"],
  ["2026-04-10", "purchase", 1700, "Wayfare Rides", "trip"],
  ["2026-04-10", "purchase", 2000, "Juniper Noodle House", "takeout"],
  ["2026-04-12", "purchase", 4500, "Larkfield Market", "groceries"],
  ["2026-04-13", "purchase", 400, "Copper Kettle Coffee", "coffee"],
  ["2026-04-16", "purchase", 900, "Copper Kettle Coffee", "coffee"],
  ["2026-04-17", "deposit", 39800, "", "Fernway Books payroll"],
  ["2026-04-17", "purchase", 2300, "Juniper Noodle House", "takeout"],
  ["2026-04-17", "transfer", 4000, "", "Save to Cushion"],
  ["2026-04-18", "purchase", 2200, "Juniper Noodle House", "takeout"],
  ["2026-04-19", "purchase", 6800, "Larkfield Market", "groceries"],
  ["2026-04-20", "purchase", 600, "Copper Kettle Coffee", "coffee"],
  ["2026-04-20", "purchase", 1100, "Hearthstone Pharmacy", "allergy relief"],
  ["2026-04-21", "purchase", 600, "Copper Kettle Coffee", "coffee"],
  ["2026-04-22", "purchase", 4500, "Brightline Wireless", "monthly plan"],
  ["2026-04-23", "purchase", 900, "Copper Kettle Coffee", "coffee"],
  ["2026-04-24", "purchase", 1700, "Juniper Noodle House", "takeout"],
  ["2026-04-25", "purchase", 1300, "Wayfare Rides", "trip"],
  ["2026-04-26", "purchase", 2500, "Larkfield Market", "groceries"],
  ["2026-04-28", "purchase", 900, "Copper Kettle Coffee", "coffee"],
  ["2026-04-30", "purchase", 500, "Copper Kettle Coffee", "coffee"],
  ["2026-05-01", "deposit", 41900, "", "Fernway Books payroll"],
  ["2026-05-01", "purchase", 1600, "Juniper Noodle House", "takeout"],
  ["2026-05-01", "transfer", 4000, "", "Save to Cushion"],
  ["2026-05-02", "withdrawal", 4000, "", "ATM withdrawal"],
  ["2026-05-03", "purchase", 7200, "Larkfield Market", "groceries"],
  ["2026-05-05", "purchase", 600, "Copper Kettle Coffee", "coffee"],
  ["2026-05-07", "purchase", 800, "Copper Kettle Coffee", "coffee"],
  ["2026-05-09", "purchase", 1200, "Lumen Streaming", "monthly subscription"],
  ["2026-05-10", "purchase", 5800, "Larkfield Market", "groceries"],
  ["2026-05-10", "purchase", 1400, "Northside Hardware", "light bulbs, tape"],
  ["2026-05-12", "purchase", 900, "Copper Kettle Coffee", "coffee"],
  ["2026-05-13", "purchase", 6000, "Larkfield Market", "groceries"],
  ["2026-05-14", "purchase", 400, "Copper Kettle Coffee", "coffee"],
  ["2026-05-15", "deposit", 41200, "", "Fernway Books payroll"],
  ["2026-05-15", "transfer", 4000, "", "Save to Cushion"],
  ["2026-05-16", "purchase", 2400, "Juniper Noodle House", "takeout"],
  ["2026-05-17", "purchase", 4400, "Larkfield Market", "groceries"],
  ["2026-05-18", "purchase", 500, "Copper Kettle Coffee", "coffee"],
  ["2026-05-22", "purchase", 4500, "Brightline Wireless", "monthly plan"],
  ["2026-05-23", "purchase", 1700, "Juniper Noodle House", "takeout"],
  ["2026-05-24", "purchase", 4300, "Larkfield Market", "groceries"],
  ["2026-05-25", "purchase", 700, "Copper Kettle Coffee", "coffee"],
  ["2026-05-27", "purchase", 3700, "Larkfield Market", "groceries"],
  ["2026-05-28", "purchase", 700, "Copper Kettle Coffee", "coffee"],
  ["2026-05-29", "deposit", 40600, "", "Fernway Books payroll"],
  ["2026-05-29", "purchase", 1600, "Juniper Noodle House", "takeout"],
  ["2026-05-29", "transfer", 4000, "", "Save to Cushion"],
  ["2026-05-31", "purchase", 2100, "Larkfield Market", "groceries"],
  ["2026-06-01", "purchase", 500, "Copper Kettle Coffee", "coffee"],
  ["2026-06-03", "purchase", 2900, "Larkfield Market", "groceries"],
  ["2026-06-04", "purchase", 700, "Copper Kettle Coffee", "coffee"],
  ["2026-06-06", "purchase", 2100, "Juniper Noodle House", "takeout"],
  ["2026-06-06", "purchase", 1400, "Wayfare Rides", "trip"],
  ["2026-06-06", "withdrawal", 6000, "", "ATM withdrawal"],
  ["2026-06-07", "purchase", 6100, "Larkfield Market", "groceries"],
  ["2026-06-09", "purchase", 1200, "Lumen Streaming", "monthly subscription"],
  ["2026-06-09", "purchase", 800, "Copper Kettle Coffee", "coffee"],
  ["2026-06-10", "purchase", 6900, "Larkfield Market", "groceries"],
  ["2026-06-11", "purchase", 800, "Copper Kettle Coffee", "coffee"],
  ["2026-06-12", "deposit", 41200, "", "Fernway Books payroll"],
  ["2026-06-12", "purchase", 1500, "Wayfare Rides", "trip"],
  ["2026-06-12", "purchase", 2300, "Juniper Noodle House", "takeout"],
  ["2026-06-12", "transfer", 4000, "", "Save to Cushion"],
  ["2026-06-13", "purchase", 1700, "Juniper Noodle House", "takeout"],
  ["2026-06-13", "purchase", 1400, "Wayfare Rides", "trip"],
  ["2026-06-15", "purchase", 2500, "Hearthstone Pharmacy", "Rx copay"],
  ["2026-06-16", "purchase", 9600, "Linen & Loom", "sheet set, pillows"],
  ["2026-06-16", "purchase", 18500, "Keyline Lock & Safe", "rekey and deadbolt install"],
  ["2026-06-17", "purchase", 15000, "Clearwater Counseling Group", "session"],
  ["2026-06-17", "purchase", 6100, "Larkfield Market", "groceries"],
  ["2026-06-17", "purchase", 1200, "Wayfare Rides", "trip"],
  ["2026-06-18", "purchase", 6400, "Northside Hardware", "door chain, motion sensor light"],
  ["2026-06-20", "purchase", 1800, "Wayfare Rides", "trip"],
  ["2026-06-20", "purchase", 29900, "Brightline Wireless", "new phone"],
  ["2026-06-21", "purchase", 6300, "Larkfield Market", "groceries"],
  ["2026-06-22", "purchase", 4500, "Brightline Wireless", "monthly plan"],
  ["2026-06-22", "purchase", 900, "Copper Kettle Coffee", "coffee"],
  ["2026-06-24", "purchase", 15000, "Clearwater Counseling Group", "session"],
  ["2026-06-24", "purchase", 1200, "Wayfare Rides", "trip"],
  ["2026-06-24", "purchase", 6600, "Larkfield Market", "groceries"],
  ["2026-06-25", "purchase", 400, "Copper Kettle Coffee", "coffee"],
  ["2026-06-26", "deposit", 23600, "", "Fernway Books payroll"],
  ["2026-06-26", "purchase", 1100, "Wayfare Rides", "trip"],
  ["2026-06-27", "purchase", 2000, "Juniper Noodle House", "takeout"],
  ["2026-06-27", "purchase", 1600, "Wayfare Rides", "trip"],
  ["2026-06-28", "purchase", 4000, "Larkfield Market", "groceries"],
  ["2026-06-29", "purchase", 1500, "Hearthstone Pharmacy", "Rx copay"],
  ["2026-07-01", "purchase", 15000, "Clearwater Counseling Group", "session"],
  ["2026-07-01", "purchase", 1200, "Wayfare Rides", "trip"],
  ["2026-07-02", "purchase", 700, "Copper Kettle Coffee", "coffee"],
  ["2026-07-02", "transfer", 30000, "", "Move to checking"],
  ["2026-07-03", "purchase", 2400, "Juniper Noodle House", "takeout"],
  ["2026-07-04", "withdrawal", 4000, "", "ATM withdrawal"],
  ["2026-07-05", "purchase", 6300, "Larkfield Market", "groceries"],
  ["2026-07-08", "purchase", 15000, "Clearwater Counseling Group", "session"],
  ["2026-07-08", "purchase", 5400, "Larkfield Market", "groceries"],
  ["2026-07-08", "purchase", 1400, "Wayfare Rides", "trip"],
  ["2026-07-09", "purchase", 1200, "Lumen Streaming", "monthly subscription"],
  ["2026-07-10", "deposit", 23600, "", "Fernway Books payroll"],
  ["2026-07-11", "purchase", 1300, "Juniper Noodle House", "takeout"],
  ["2026-07-12", "purchase", 2100, "Larkfield Market", "groceries"],
  ["2026-07-15", "purchase", 1200, "Wayfare Rides", "trip"],
  ["2026-07-15", "purchase", 6300, "Larkfield Market", "groceries"],
  ["2026-07-15", "purchase", 65000, "Elm Court Apartments", "security deposit"],
  ["2026-07-15", "purchase", 15000, "Clearwater Counseling Group", "session"],
  ["2026-07-16", "purchase", 500, "Copper Kettle Coffee", "coffee"],
  ["2026-07-17", "purchase", 1900, "Juniper Noodle House", "takeout"],
  ["2026-07-18", "purchase", 18900, "Two Rivers Truck Rental", "10 ft truck, 1 day"],
  ["2026-07-18", "purchase", 1500, "Wayfare Rides", "trip"],
  ["2026-07-19", "purchase", 6800, "Larkfield Market", "groceries"],
  ["2026-07-22", "purchase", 4500, "Brightline Wireless", "monthly plan"],
  ["2026-07-22", "purchase", 6400, "Larkfield Market", "groceries"],
  ["2026-07-22", "purchase", 15000, "Clearwater Counseling Group", "session"],
  ["2026-07-24", "deposit", 23600, "", "Fernway Books payroll"],
  ["2026-07-24", "purchase", 2400, "Juniper Noodle House", "takeout"],
  ["2026-07-24", "purchase", 1600, "Wayfare Rides", "trip"],
  ["2026-07-25", "purchase", 1800, "Juniper Noodle House", "takeout"],
  ["2026-07-26", "purchase", 3500, "Larkfield Market", "groceries"],
  ["2026-07-27", "purchase", 1500, "Hearthstone Pharmacy", "Rx copay"],
  ["2026-07-29", "purchase", 3500, "Larkfield Market", "groceries"],
  ["2026-07-29", "purchase", 15000, "Clearwater Counseling Group", "session"],
  ["2026-07-29", "purchase", 1300, "Wayfare Rides", "trip"],
  ["2026-08-01", "withdrawal", 6000, "", "ATM withdrawal"],
  ["2026-08-02", "purchase", 2000, "Larkfield Market", "groceries"],
  ["2026-08-03", "transfer", 25000, "", "Move to checking"],
  ["2026-08-05", "purchase", 1300, "Wayfare Rides", "trip"],
  ["2026-08-05", "purchase", 15000, "Clearwater Counseling Group", "session"],
  ["2026-08-07", "deposit", 40400, "", "Fernway Books payroll"],
  ["2026-08-09", "purchase", 1200, "Lumen Streaming", "monthly subscription"],
  ["2026-08-09", "purchase", 4800, "Larkfield Market", "groceries"],
  ["2026-08-12", "purchase", 15000, "Clearwater Counseling Group", "session"],
  ["2026-08-12", "purchase", 1300, "Wayfare Rides", "trip"],
  ["2026-08-13", "purchase", 400, "Copper Kettle Coffee", "coffee"],
  ["2026-08-14", "purchase", 1800, "Juniper Noodle House", "takeout"],
  ["2026-08-16", "purchase", 5600, "Larkfield Market", "groceries"],
  ["2026-08-19", "purchase", 7400, "Larkfield Market", "groceries"],
  ["2026-08-19", "purchase", 1300, "Wayfare Rides", "trip"],
  ["2026-08-19", "purchase", 15000, "Clearwater Counseling Group", "session"],
  ["2026-08-20", "purchase", 800, "Copper Kettle Coffee", "coffee"],
  ["2026-08-21", "deposit", 41200, "", "Fernway Books payroll"],
  ["2026-08-21", "purchase", 1800, "Juniper Noodle House", "takeout"],
  ["2026-08-22", "purchase", 4500, "Brightline Wireless", "monthly plan"],
  ["2026-08-22", "purchase", 1400, "Juniper Noodle House", "takeout"],
  ["2026-08-23", "purchase", 5000, "Larkfield Market", "groceries"],
  ["2026-08-24", "purchase", 1500, "Hearthstone Pharmacy", "Rx copay"],
  ["2026-08-24", "purchase", 800, "Copper Kettle Coffee", "coffee"],
  ["2026-08-26", "purchase", 2000, "Larkfield Market", "groceries"],
  ["2026-08-26", "purchase", 1200, "Wayfare Rides", "trip"],
  ["2026-08-26", "purchase", 15000, "Clearwater Counseling Group", "session"],
  ["2026-08-27", "purchase", 900, "Copper Kettle Coffee", "coffee"],
  ["2026-08-29", "purchase", 1800, "Juniper Noodle House", "takeout"],
  ["2026-08-30", "purchase", 2000, "Larkfield Market", "groceries"],
  ["2026-09-02", "purchase", 15000, "Clearwater Counseling Group", "session"],
  ["2026-09-04", "deposit", 39700, "", "Fernway Books payroll"],
  ["2026-09-05", "purchase", 1300, "Juniper Noodle House", "takeout"],
  ["2026-09-05", "withdrawal", 4000, "", "ATM withdrawal"],
  ["2026-09-06", "purchase", 1800, "Larkfield Market", "groceries"],
  ["2026-09-09", "purchase", 15000, "Clearwater Counseling Group", "session"],
  ["2026-09-09", "purchase", 1200, "Wayfare Rides", "trip"],
  ["2026-09-09", "purchase", 5400, "Larkfield Market", "groceries"],
  ["2026-09-09", "purchase", 1200, "Lumen Streaming", "monthly subscription"],
  ["2026-09-11", "purchase", 2100, "Juniper Noodle House", "takeout"],
  ["2026-09-11", "purchase", 900, "Wayfare Rides", "trip"],
  ["2026-09-13", "purchase", 2500, "Larkfield Market", "groceries"],
  ["2026-09-16", "purchase", 15000, "Clearwater Counseling Group", "session"],
  ["2026-09-16", "purchase", 1400, "Wayfare Rides", "trip"],
  ["2026-09-18", "deposit", 41800, "", "Fernway Books payroll"],
  ["2026-09-18", "purchase", 2300, "Juniper Noodle House", "takeout"],
  ["2026-09-18", "purchase", 1100, "Wayfare Rides", "trip"],
  ["2026-09-20", "purchase", 3000, "Larkfield Market", "groceries"],
  ["2026-09-22", "purchase", 4500, "Brightline Wireless", "monthly plan"],
  ["2026-09-22", "purchase", 600, "Copper Kettle Coffee", "coffee"],
  ["2026-09-23", "purchase", 1200, "Wayfare Rides", "trip"],
  ["2026-09-23", "purchase", 15000, "Clearwater Counseling Group", "session"],
  ["2026-09-27", "purchase", 4900, "Larkfield Market", "groceries"],
  ["2026-09-30", "purchase", 15000, "Clearwater Counseling Group", "session"],
  ["2026-09-30", "purchase", 5600, "Larkfield Market", "groceries"],
  ["2026-09-30", "purchase", 1400, "Wayfare Rides", "trip"],
  ["2026-10-02", "deposit", 41200, "", "Fernway Books payroll"],
];

export const ROWAN_OPENING_CENTS = 285000;
export const ROWAN_ACCOUNT = { id: "8ff7e76a-0d1a-4327-b13d-4a8ffa529434", nickname: "Checking", mask: "0011" };

// The pending hospital bill in the bank, which the itemized statement below explains.
export const ROWAN_BANK_BILL = {
  id: "c1398337-ac9d-4216-a449-ab7ac2a9e9b4",
  payee: "Riverbend General Hospital",
  amount_cents: 44300,
  date: "2026-10-03",
  due: "2026-10-20",
};

export const SAMPLE_BILL_NAME = "riverbend-itemized-statement-fictional.pdf";
export const SAMPLE_BILL_SHA256 = "231c5c86178943f9b448534a0dd3f8232bcfa61d2a66d63c45c8856c333d9104";
export const SAMPLE_BILL_BASE64 =
  "JVBERi0xLjQKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwK" +
  "L0YxIDIgMCBSIC9GMiAzIDAgUgo+PgplbmRvYmoKMiAwIG9iago8PAovQmFzZUZvbnQgL0hlbHZldGljYSAvRW5jb2Rpbmcg" +
  "L1dpbkFuc2lFbmNvZGluZyAvTmFtZSAvRjEgL1N1YnR5cGUgL1R5cGUxIC9UeXBlIC9Gb250Cj4+CmVuZG9iagozIDAgb2Jq" +
  "Cjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhLUJvbGQgL0VuY29kaW5nIC9XaW5BbnNpRW5jb2RpbmcgL05hbWUgL0YyIC9TdWJ0" +
  "eXBlIC9UeXBlMSAvVHlwZSAvRm9udAo+PgplbmRvYmoKNCAwIG9iago8PAovQ29udGVudHMgOCAwIFIgL01lZGlhQm94IFsg" +
  "MCAwIDYxMiA3OTIgXSAvUGFyZW50IDcgMCBSIC9SZXNvdXJjZXMgPDwKL0ZvbnQgMSAwIFIgL1Byb2NTZXQgWyAvUERGIC9U" +
  "ZXh0IC9JbWFnZUIgL0ltYWdlQyAvSW1hZ2VJIF0KPj4gL1JvdGF0ZSAwIC9UcmFucyA8PAoKPj4gCiAgL1R5cGUgL1BhZ2UK" +
  "Pj4KZW5kb2JqCjUgMCBvYmoKPDwKL1BhZ2VNb2RlIC9Vc2VOb25lIC9QYWdlcyA3IDAgUiAvVHlwZSAvQ2F0YWxvZwo+Pgpl" +
  "bmRvYmoKNiAwIG9iago8PAovQXV0aG9yIChUZW5kIGRlbW8gc2VlZCkgL0NyZWF0aW9uRGF0ZSAoRDoyMDAwMDEwMTAwMDAw" +
  "MCswMCcwMCcpIC9DcmVhdG9yIChhbm9ueW1vdXMpIC9LZXl3b3JkcyAoKSAvTW9kRGF0ZSAoRDoyMDAwMDEwMTAwMDAwMCsw" +
  "MCcwMCcpIC9Qcm9kdWNlciAoUmVwb3J0TGFiIFBERiBMaWJyYXJ5IC0gXChvcGVuc291cmNlXCkpIAogIC9TdWJqZWN0IChG" +
  "aWN0aW9uYWwgaXRlbWl6ZWQgaG9zcGl0YWwgc3RhdGVtZW50IGZvciBhIGhhY2thdGhvbiBkZW1vKSAvVGl0bGUgKFJpdmVy" +
  "YmVuZCBHZW5lcmFsIEhvc3BpdGFsIHN0YXRlbWVudCBcKGZpY3Rpb25hbCBkZW1vXCkpIC9UcmFwcGVkIC9GYWxzZQo+Pgpl" +
  "bmRvYmoKNyAwIG9iago8PAovQ291bnQgMSAvS2lkcyBbIDQgMCBSIF0gL1R5cGUgL1BhZ2VzCj4+CmVuZG9iago4IDAgb2Jq" +
  "Cjw8Ci9GaWx0ZXIgWyAvQVNDSUk4NURlY29kZSAvRmxhdGVEZWNvZGUgXSAvTGVuZ3RoIDEzNjEKPj4Kc3RyZWFtCkdhdCVj" +
  "OTJqazEmQkY2ZU1FWXVlVkQ6SyQtLVBHOmpZOVMjSj09UyRbVkBGUC9PNHF1VmVjU3JxcnRUTzdpaXBKMS47UE5pa04nLzVJ" +
  "Sic7InIuKT5vMDhXRXImJzYjKVs7OD1wX2ZHQSFsanRSNFsoJC9UWF40T0BjZGtbVTYkbEtUbVNsQjVtZ0Y+IV9FT3UnTThK" +
  "Uj9WXnNmOVNQODUtNV1aKTUnXF4rLzVCbCtFLzVHTFBYTSZNcjBoY1VLUDZKLXFeSiZrZ2cscy8qWnAuMkUtNDxpS1dFLzpe" +
  "SVFsZEBmZDAwJTJ0ZiUkbW1tVSJ1K042MjBoPzhVNGgtbVJiOmtXIkBiR2tHanFkMWVcS2h1LkFVUVpKP0U9JlgtOiIiMzk7" +
  "PVohb3IvbHJuPChiVTE3VUY/OzEtO0dkdVRhVS5va3NtKDRcb2NLb2I9UmhDQGFtOUctIWFXTXE5WixwJEchdVhSOiEkbUBn" +
  "Xl1aaGdUa04oRT4nR2BpUzMrXz5LcEJ1Xlt1XEsuTDNYOUhFYC8sKCh1OWIhKF9yT2NmKnQ9JihqXXEqXzJaXV5TbGdzS1Ze" +
  "Xk0/QE9oLnFWPzY7UiRWMl9dOyd1KCxYaSRYPlByTlJJS25yPFpaWy1lPVtALGJLOUY9ZSVFSldRbl9lZDQ1LG1rSTxlK3Fc" +
  "T0pKOD4qNWlab1xjZVNmb2pybSZkNydMMlc5VGlrVmYsKnI6cXNDajhOOGxWR2NBVEA6M1BcPWkiNWBGdG08KChwLzkhUUBN" +
  "dHQ4dTQnL2Y0XztbaUZFMnRlVGgwJ1s4N2BzLUMwTT4rSDM2QUApRC5sRWU8alNBTVJfLTUkUV5DXkszTDIjKko6JTYsV24u" +
  "PTxfSiE5JWglQElqPkpKJFJWSzlNYzUzKzZMOGdwOilDQGAqXzIqPk1cYTAkSl4uO2lFV2U8bW5YXEhgal1BaFMxUkdEZlE3" +
  "WSNNOGo4aXMoamlFSm5zOEs+KHVLWmRHJl42bSVmTnB0dSpCSVI4bVM4Ikk9UCN0PSNpYC9DYW9fNiJ1aCdxaFFPZG9sS0hv" +
  "Xi9YQExnQXRxSEFgNStzKzY8JW4laXQ4SVVZSj5OXVM1QD5ebSlDLjs7X1FIP18xNERUQCI1UEBrMmdZRT42U2JAQUVPQ2Ii" +
  "N1lib2BnZmRuJnVELlRzWSxmTkcxSHM9R25UJ2BBQjtgOCJxLSdXXVUxQmFkW0NILjxRb1NdIWcnUCJ1UU1JZictbUklci5n" +
  "W0pYWywmViU3MEFCZlElLDUpTTE5IiI7WENDS1BIIkBYQ3M2QWhLNilYPU1bWmVwY1QkOSQrNEJePm5tYGNuYi5NIj1BYjQx" +
  "TU4oSXVQK2lbYU8/X1lmVlJAIypQXyY/QnUjaSgnbUohLStwTWYydTQhPydMOF1cNWIvIkQxQ2J0QUUuaSlXbTxCLSM/QipY" +
  "KFVKWVxpUUBYMz5gLU1aZTZRZEA5bDhhLVVLdDlIVUxnaG08MllFWVNeSDhkSUlBKVttRTtoVUpKVSJJTlU4Ty5lIjYsXSY6" +
  "NFtcWzQsX2ooJSxNX1NjPXVKSTFaO0JtKUBzP2A/VDgjTmdHK105KW1Ecz9RYm5MbXAuJ21ycTpDNiptPDtgSitTXldMckZb" +
  "KSItKVwyWlczIjozVjhrTkxGJzFdXihzRjUhZmFaaV4kOEc9WycjTStgNDA6Kj5oIW8uUCIiLG9MXjBQa1Q7RTRZJ2whY1tT" +
  "c2ZdQG9CRjNPTk1aPDRRRFVbVGFPLiNpMFQ2ZU1wcEJpWUg6Tz1pTE9qPmwmWmtrW1BRKFtZQS85KH4+ZW5kc3RyZWFtCmVu" +
  "ZG9iagp4cmVmCjAgOQowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwNjEgMDAwMDAgbiAKMDAwMDAwMDEwMiAwMDAwMCBu" +
  "IAowMDAwMDAwMjA5IDAwMDAwIG4gCjAwMDAwMDAzMjEgMDAwMDAgbiAKMDAwMDAwMDUxNCAwMDAwMCBuIAowMDAwMDAwNTgy" +
  "IDAwMDAwIG4gCjAwMDAwMDA5NDIgMDAwMDAgbiAKMDAwMDAwMTAwMSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9JRCAKWzxjODgw" +
  "ZWYyNzVkNmY5ZTQ2ZTA4MTFkODg0NmJjY2EzOT48Yzg4MGVmMjc1ZDZmOWU0NmUwODExZDg4NDZiY2NhMzk+XQolIFJlcG9y" +
  "dExhYiBnZW5lcmF0ZWQgUERGIGRvY3VtZW50IC0tIGRpZ2VzdCAob3BlbnNvdXJjZSkKCi9JbmZvIDYgMCBSCi9Sb290IDUg" +
  "MCBSCi9TaXplIDkKPj4Kc3RhcnR4cmVmCjI0NTMKJSVFT0YK";
