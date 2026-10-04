// Words for the demo bank pieces of Track: the program's demo payment and the bank records panel.
// English and Spanish, same shape (the Spanish is typed as the English), the same copy rules as
// lib/i18n (tests/bank.test.tsx checks them). Kept beside the components so lib/i18n stays as it is.
import type { Lang } from "@/lib/i18n";

type TermKey = "deposits" | "purchases" | "withdrawals" | "transfers_out" | "transfers_in";
type Kind = "purchase" | "deposit" | "withdrawal" | "transfer";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const en = {
  demoTag: "Demo",
  fictionalTag: "Fictional",
  payout: {
    title: "When the program pays",
    lead: "See what your garden looks like once the program pays. This is a demo with made-up money.",
    amount: (amount: string) => `Demo amount: ${amount}, what your claim asks for now.`,
    button: "Show what it looks like when the program pays (demo)",
    working: "Asking the demo bank",
    to: "your account, from the program (demo)",
    done: (amount: string, program: string) => `Demo: ${program} paid ${amount} into your account.`,
    bank: (id: string) => `Nessie, the demo bank, recorded it as deposit ${id}.`,
    local: "Tend is not connected to the demo bank, so nothing was recorded. The plants show what it would look like.",
    whole: (deposit: string, claim: string) =>
      `Nessie keeps whole dollars, so the deposit is ${deposit}. Your claim is ${claim}.`,
    claimNow: (claim: string) => `Your claim asks for ${claim} now.`,
    theProgram: "The program",
    decides: "It is not real money. The program decides what it pays, and when.",
    plant: "Paid in the demo",
    undo: "Undo the demo payment",
    undoing: "Undoing",
    nothing: "Nothing to pay yet. Say yes to a cost first.",
    failed: (msg: string) => `The demo payment did not work: ${msg}`,
  },
  activity: {
    title: "Bank records (demo)",
    lead: "What Tend read from Nessie, Capital One's mock bank, and what it wrote there for this made-up account. Each record shows its Nessie id.",
    show: "Show the bank records",
    refresh: "Read them again",
    hide: "Hide the bank records",
    loading: "Reading the demo bank",
    local: "Tend is not connected to the demo bank here, so there are no records to show.",
    failed: (msg: string) => `Tend could not read the demo bank: ${msg}`,
    live: (time: string) => `Read from Nessie at ${time}.`,
    saved: "Nessie did not answer, so this is the saved copy of the demo bank.",
    dryRun: "On this server, payments are a dry run: Tend records them here and does not send them to Nessie.",
    id: "Nessie id",
    opening: "Opening balance",
    openingNote: "Nessie's own balance field. It never changes, so Tend adds up the records.",
    term: (key: TermKey, n: number) =>
      ({
        deposits: plural(n, "deposit", "deposits"),
        purchases: plural(n, "purchase", "purchases"),
        withdrawals: plural(n, "withdrawal", "withdrawals"),
        transfers_out: plural(n, "transfer out", "transfers out"),
        transfers_in: plural(n, "transfer in", "transfers in"),
      })[key],
    computed: "Balance Tend computes",
    addsUp: "Adds up",
    noMatch: "Does not add up",
    notCounted: (n: number) => `${plural(n, "record", "records")} not counted: cancelled, or paid with points.`,
    notShown: (n: number) =>
      `${plural(n, "record", "records")} on this account are not demo data, so they are not shown. They are in the balance.`,
    billTitle: (payee: string) => `Bill from ${payee}`,
    itemized: "Total on the itemized bill",
    paidBy: (id: string, lines: string) => (lines ? `Paid lines ${lines}, withdrawal ${id}` : `Paid, withdrawal ${id}`),
    left: "Left on the bill",
    bankSays: (status: string) => `Nessie's bill says (${status})`,
    notInBank: "This bill is not in the bank now.",
    held: (note: string) => `Held: ${note}. Tend will not pay it.`,
    nickname: (text: string) => `Its nickname in Nessie: ${text}`,
    nicknameChanged: "Its nickname was changed outside Tend, so it is not shown.",
    billMatches: "Matches",
    billDiffers: "Does not match",
    writesTitle: "What Tend wrote to Nessie",
    writesNone: "Nothing yet.",
    payment: (payee: string) => `Payment to ${payee}`,
    paymentElsewhere: "Payment to someone outside the demo",
    payout: (program: string) => `${program}, demo payment`,
    forBill: (lines: string) => (lines ? `For bill lines ${lines}` : "For the bill"),
    dryRunTitle: "Dry run records on Tend's server",
    recordsTitle: (n: number) => `Every record Tend read (${n})`,
    kind: (kind: Kind, n: number) =>
      ({
        purchase: `Purchases (${n})`,
        deposit: `Deposits (${n})`,
        withdrawal: `Withdrawals (${n})`,
        transfer: `Transfers (${n})`,
      })[kind],
    tendWrote: "Tend wrote this",
    changed: "Changed since the demo was set up",
    transferTo: (to: string) => `To ${to}`,
    callsTitle: (n: number) => `The API calls behind this view (${n})`,
    callNote: (ms: number, count: number | null) =>
      count === null ? `${ms} ms` : `${plural(count, "record", "records")}, ${ms} ms`,
    noAnswer: "no answer",
    dateCol: "Date",
    whatCol: "What",
    amountCol: "Amount",
  },
};

export type BankText = typeof en;

const es: BankText = {
  demoTag: "Demostración",
  fictionalTag: "Ficticio",
  payout: {
    title: "Cuando el programa paga",
    lead: "Mira cómo se ve tu jardín cuando el programa paga. Es una demostración con dinero inventado.",
    amount: (amount: string) => `Monto de demostración: ${amount}, lo que pide tu solicitud ahora.`,
    button: "Mostrar cómo se ve cuando el programa paga (demostración)",
    working: "Consultando el banco de demostración",
    to: "tu cuenta, del programa (demostración)",
    done: (amount: string, program: string) => `Demostración: ${program} pagó ${amount} a tu cuenta.`,
    bank: (id: string) => `Nessie, el banco de demostración, lo registró como el depósito ${id}.`,
    local:
      "Tend no está conectado al banco de demostración, así que no se registró nada. Las plantas muestran cómo se vería.",
    whole: (deposit: string, claim: string) =>
      `Nessie guarda solo dólares enteros, así que el depósito es ${deposit}. Tu solicitud es ${claim}.`,
    claimNow: (claim: string) => `Ahora tu solicitud pide ${claim}.`,
    theProgram: "El programa",
    decides: "No es dinero real. El programa decide lo que paga y cuándo.",
    plant: "Pagado en la demostración",
    undo: "Deshacer el pago de demostración",
    undoing: "Deshaciendo",
    nothing: "Todavía no hay nada que pagar. Primero di que sí a un gasto.",
    failed: (msg: string) => `El pago de demostración no funcionó: ${msg}`,
  },
  activity: {
    title: "Registros del banco (demostración)",
    lead: "Lo que Tend leyó de Nessie, el banco de prueba de Capital One, y lo que escribió allí para esta cuenta inventada. Cada registro muestra su id de Nessie.",
    show: "Mostrar los registros del banco",
    refresh: "Leerlos de nuevo",
    hide: "Ocultar los registros del banco",
    loading: "Leyendo el banco de demostración",
    local: "Aquí Tend no está conectado al banco de demostración, así que no hay registros que mostrar.",
    failed: (msg: string) => `Tend no pudo leer el banco de demostración: ${msg}`,
    live: (time: string) => `Leído de Nessie a las ${time}.`,
    saved: "Nessie no respondió, así que esta es la copia guardada del banco de demostración.",
    dryRun: "En este servidor los pagos son de prueba: Tend los registra aquí y no los envía a Nessie.",
    id: "Id de Nessie",
    opening: "Saldo inicial",
    openingNote: "El campo de saldo de Nessie. Nunca cambia, así que Tend suma los registros.",
    term: (key: TermKey, n: number) =>
      ({
        deposits: plural(n, "depósito", "depósitos"),
        purchases: plural(n, "compra", "compras"),
        withdrawals: plural(n, "retiro", "retiros"),
        transfers_out: plural(n, "transferencia enviada", "transferencias enviadas"),
        transfers_in: plural(n, "transferencia recibida", "transferencias recibidas"),
      })[key],
    computed: "Saldo que calcula Tend",
    addsUp: "Cuadra",
    noMatch: "No cuadra",
    notCounted: (n: number) => `${plural(n, "registro", "registros")} sin contar: cancelados o pagados con puntos.`,
    notShown: (n: number) =>
      `${plural(n, "registro", "registros")} de esta cuenta no son datos de demostración, así que no se muestran. Sí están en el saldo.`,
    billTitle: (payee: string) => `Factura de ${payee}`,
    itemized: "Total de la factura detallada",
    paidBy: (id: string, lines: string) =>
      lines ? `Pagadas las líneas ${lines}, retiro ${id}` : `Pagada, retiro ${id}`,
    left: "Lo que queda en la factura",
    bankSays: (status: string) => `La factura en Nessie dice (${status})`,
    notInBank: "Esta factura ya no está en el banco.",
    held: (note: string) => `Retenido: ${note}. Tend no lo pagará.`,
    nickname: (text: string) => `Su nombre en Nessie: ${text}`,
    nicknameChanged: "Su nombre se cambió fuera de Tend, así que no se muestra.",
    billMatches: "Coincide",
    billDiffers: "No coincide",
    writesTitle: "Lo que Tend escribió en Nessie",
    writesNone: "Nada todavía.",
    payment: (payee: string) => `Pago a ${payee}`,
    paymentElsewhere: "Pago a alguien fuera de la demostración",
    payout: (program: string) => `${program}, pago de demostración`,
    forBill: (lines: string) => (lines ? `Por las líneas ${lines} de la factura` : "Por la factura"),
    dryRunTitle: "Registros de prueba en el servidor de Tend",
    recordsTitle: (n: number) => `Todos los registros que leyó Tend (${n})`,
    kind: (kind: Kind, n: number) =>
      ({
        purchase: `Compras (${n})`,
        deposit: `Depósitos (${n})`,
        withdrawal: `Retiros (${n})`,
        transfer: `Transferencias (${n})`,
      })[kind],
    tendWrote: "Lo escribió Tend",
    changed: "Cambió desde que se preparó la demostración",
    transferTo: (to: string) => `A ${to}`,
    callsTitle: (n: number) => `Las llamadas a la API detrás de esta vista (${n})`,
    callNote: (ms: number, count: number | null) =>
      count === null ? `${ms} ms` : `${plural(count, "registro", "registros")}, ${ms} ms`,
    noAnswer: "sin respuesta",
    dateCol: "Fecha",
    whatCol: "Qué",
    amountCol: "Monto",
  },
};

export const BANK_TEXT: Record<Lang, BankText> = { en, es };
