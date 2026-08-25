/**
 * Renderers for the contents of uploaded documents.
 *
 * The point of these is that the decisive fact is *inside* the file, written
 * the way a garage or a police station writes it, rather than restated in a
 * field the adjudicator can read off. A repair estimate that contradicts the
 * claimed amount is only a test of anything if the total has to be found in
 * the middle of an itemised bill.
 *
 * Two lines are load-bearing and machine-readable on purpose, because the
 * evaluation set has to be able to check its own consistency:
 *
 *   "<label> (INR): 1,84,500"        -- the money total
 *   "Date of occurrence: 2026-03-11" -- the date the document asserts
 *
 * `analyse.ts` parses exactly those two, and nothing else.
 */
import { Rng, inr, addDays } from './rng.js';
import type { ClaimType, EvalDocument } from './types.js';

export interface DocContext {
  rng: Rng;
  claimType: ClaimType;
  incidentDate: string;
  /** The date the document itself asserts. Equal to `incidentDate` unless a
   *  mismatch has been planted. */
  documentDate: string;
  /** The money total the document states. */
  total: number;
  customerName: string;
  city: string;
  road: string;
  station: string;
  garage: string;
  contractor: string;
  hospital: string;
  vehicle: string;
  registration: string;
  /** First sentence of the incident, for documents that restate it. */
  summary: string;
}

const MIME_TEXT = 'text/plain';
const MIME_PDF = 'application/pdf';
const MIME_JPEG = 'image/jpeg';

function money(label: string, amount: number): string {
  return `${label} (INR): ${inr(amount)}`;
}

/** Split a total into believable line items that sum to it exactly. */
function lineItems(rng: Rng, total: number, labels: readonly string[]): string[] {
  const n = Math.min(labels.length, Math.max(2, rng.int(3, labels.length)));
  const chosen = rng.sample(labels, n);
  const weights = chosen.map(() => rng.int(10, 60));
  const sum = weights.reduce((a, b) => a + b, 0);
  let running = 0;
  const out: string[] = [];
  chosen.forEach((label, i) => {
    const amount =
      i === chosen.length - 1 ? total - running : Math.round((total * weights[i]!) / sum / 10) * 10;
    running += amount;
    out.push(`  ${label.padEnd(38, '.')} ${inr(amount)}`);
  });
  return out;
}

const REPAIR_LABELS = [
  'Bumper assembly - replace',
  'Bonnet - repair and refinish',
  'Headlamp unit (RH)',
  'Radiator support panel',
  'Front door skin - replace',
  'Suspension arm - replace',
  'Paint and materials',
  'Labour - panel beating (14 hrs)',
  'Wheel alignment',
];

const RESTORATION_LABELS = [
  'Strip out damaged gypsum and plaster',
  'Anti-fungal treatment to affected walls',
  'Replace modular kitchen carcass',
  'Electrical rewiring - affected circuits',
  'Flooring - lift, dry and relay',
  'Painting - two coats, affected rooms',
  'Debris removal and disposal',
  'Labour and site supervision',
];

const HOSPITAL_LABELS = [
  'Room charges (3 nights, semi-private)',
  'Surgeon fee',
  'Anaesthetist fee',
  'Operation theatre charges',
  'Investigations - pathology',
  'Investigations - radiology',
  'Pharmacy and consumables',
  'Nursing charges',
];

export function renderDocument(type: string, ctx: DocContext): EvalDocument {
  const { rng } = ctx;
  const ref = () => rng.int(100000, 999999);

  switch (type) {
    case 'police_report':
      return {
        document_type: type,
        original_filename: `FIR_${ctx.station.replace(/\s+/g, '_')}_${ref()}.pdf`,
        mime_type: MIME_PDF,
        content: [
          `POLICE STATION: ${ctx.station}, ${ctx.city}`,
          `FIR No: ${rng.int(100, 899)}/${ctx.documentDate.slice(0, 4)}`,
          `Date of occurrence: ${ctx.documentDate}`,
          `Time of occurrence: ${String(rng.int(0, 23)).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')} hrs`,
          `Place of occurrence: ${ctx.road}, ${ctx.city}`,
          `Complainant: ${ctx.customerName}`,
          `Date of report: ${addDays(ctx.documentDate, rng.int(0, 2))}`,
          '',
          'Brief facts as stated by the complainant:',
          `  ${ctx.summary}`,
          '',
          `Investigating officer: SI ${rng.pick(['Kadam', 'Reddy', 'Menon', 'Bhosale', 'Sekhar'])}`,
          'Status: under investigation',
        ].join('\n'),
      };

    case 'fire_dept_report':
      return {
        document_type: type,
        original_filename: `fire_service_report_${ref()}.pdf`,
        mime_type: MIME_PDF,
        content: [
          `${ctx.city.toUpperCase()} FIRE AND EMERGENCY SERVICES`,
          `Call reference: FS/${ctx.documentDate.slice(0, 4)}/${rng.int(1000, 9999)}`,
          `Date of call: ${ctx.documentDate}`,
          `Time of call: ${String(rng.int(0, 23)).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')} hrs`,
          `Address attended: ${ctx.road}, ${ctx.city}`,
          `Appliances attended: ${rng.int(1, 3)}`,
          '',
          'Observations on arrival:',
          `  ${ctx.summary}`,
          '',
          `Probable cause recorded: ${rng.pick([
            'electrical short circuit',
            'ignition at cooking appliance',
            'under investigation',
          ])}`,
          `Station officer: ${rng.pick(['S. Pillai', 'D. Mahajan', 'A. Bora', 'R. Vaidya'])}`,
        ].join('\n'),
      };

    case 'repair_estimate':
      return {
        document_type: type,
        original_filename: `estimate_${ctx.garage.split(' ')[0]!.toLowerCase()}_${ref()}.pdf`,
        mime_type: MIME_PDF,
        content: [
          `${ctx.garage.toUpperCase()}`,
          `${ctx.road}, ${ctx.city}`,
          `GSTIN: ${rng.int(10, 36)}ABCDE${rng.int(1000, 9999)}F1Z${rng.int(0, 9)}`,
          '',
          `Estimate for: ${ctx.vehicle} (${ctx.registration})`,
          `Owner: ${ctx.customerName}`,
          `Date of estimate: ${addDays(ctx.incidentDate, rng.int(1, 8))}`,
          '',
          'Items:',
          ...lineItems(rng, ctx.total, REPAIR_LABELS),
          '',
          money('Grand total', ctx.total),
          'Estimate valid for 30 days. Subject to inspection after strip-down.',
        ].join('\n'),
      };

    case 'contractor_estimate':
    case 'contractor_estimates':
      return {
        document_type: type,
        original_filename: `restoration_quote_${ref()}.pdf`,
        mime_type: MIME_PDF,
        content: [
          `${ctx.contractor.toUpperCase()}`,
          `${ctx.city}`,
          '',
          `Quotation for reinstatement works at the premises of ${ctx.customerName}`,
          `Site visited on: ${addDays(ctx.incidentDate, rng.int(1, 6))}`,
          '',
          'Scope and rates:',
          ...lineItems(rng, ctx.total, RESTORATION_LABELS),
          '',
          money('Estimate total', ctx.total),
          'Excludes any structural work found necessary after strip-out.',
        ].join('\n'),
      };

    case 'plumber_invoice':
      return {
        document_type: type,
        original_filename: `plumber_invoice_${ref()}.pdf`,
        mime_type: MIME_PDF,
        content: [
          `${rng.pick(['Shree Sai Plumbing', 'Aqua Fix Services', 'Metro Sanitary Works'])}`,
          `Invoice No: ${rng.int(2000, 8999)}`,
          `Attended on: ${addDays(ctx.incidentDate, rng.int(0, 2))}`,
          `Customer: ${ctx.customerName}`,
          '',
          'Work carried out:',
          '  Isolated supply at the mains and drained the affected line.',
          '  Replaced the failed section and pressure-tested the run.',
          `  Advised on drying out before any reinstatement work begins.`,
          '',
          money('Invoice total', rng.rupees(2_500, 14_000)),
          'Note: this invoice covers the emergency plumbing call only, not reinstatement.',
        ].join('\n'),
      };

    case 'proof_of_purchase':
      return {
        document_type: type,
        original_filename: `purchase_invoice_${ref()}.pdf`,
        mime_type: MIME_PDF,
        content: [
          `${rng.pick(['Vijay Sales', 'Croma', 'Tanishq', 'Reliance Digital', 'Kalyan Jewellers'])}`,
          `Tax invoice ${rng.int(100000, 999999)}`,
          `Billed to: ${ctx.customerName}`,
          `Date of purchase: ${addDays(ctx.incidentDate, -rng.int(120, 900))}`,
          '',
          'Items:',
          ...lineItems(rng, ctx.total, [
            'Item as described on the claim form',
            'Extended warranty',
            'Delivery and installation',
            'GST',
          ]),
          '',
          money('Invoice total', ctx.total),
        ].join('\n'),
      };

    case 'itemized_bill':
      return {
        document_type: type,
        original_filename: `final_bill_${ref()}.pdf`,
        mime_type: MIME_PDF,
        content: [
          `${ctx.hospital.toUpperCase()} — FINAL BILL`,
          `Patient: ${ctx.customerName}`,
          `UHID: ${rng.int(1000000, 9999999)}`,
          `Date of admission: ${ctx.incidentDate}`,
          `Date of discharge: ${addDays(ctx.incidentDate, rng.int(1, 6))}`,
          '',
          'Charges:',
          ...lineItems(rng, ctx.total, HOSPITAL_LABELS),
          '',
          money('Net payable', ctx.total),
        ].join('\n'),
      };

    case 'medical_records':
      return {
        document_type: type,
        original_filename: `discharge_summary_${ref()}.pdf`,
        mime_type: MIME_PDF,
        content: [
          `${ctx.hospital.toUpperCase()} — DISCHARGE SUMMARY`,
          `Patient: ${ctx.customerName}`,
          `Date of admission: ${ctx.documentDate}`,
          `Date of discharge: ${addDays(ctx.documentDate, rng.int(1, 6))}`,
          '',
          'Clinical course:',
          `  ${ctx.summary}`,
          '',
          `Condition on discharge: ${rng.pick(['stable', 'stable, ambulatory', 'improved'])}`,
          `Consultant: Dr ${rng.pick(['Sridhar', 'Kulkarni', 'Bhattacharya', 'Nambiar', 'Grewal'])}`,
        ].join('\n'),
      };

    case 'referral_letter':
      return {
        document_type: type,
        original_filename: `referral_${ref()}.pdf`,
        mime_type: MIME_PDF,
        content: [
          `Dr ${rng.pick(['Anitha Rao', 'Praveen Shetty', 'Nilofer Khan', 'Sameer Dutta'])}, MBBS MD`,
          `${ctx.city}`,
          `Date: ${addDays(ctx.incidentDate, -rng.int(0, 20))}`,
          '',
          `Kindly see ${ctx.customerName}, who has been under my care.`,
          `  ${ctx.summary}`,
          'Referred for further evaluation and management as appropriate.',
        ].join('\n'),
      };

    case 'other_driver_info':
      return {
        document_type: type,
        original_filename: `third_party_details_${ref()}.pdf`,
        mime_type: MIME_PDF,
        content: [
          'THIRD PARTY DETAILS (recorded at the scene)',
          `Name: ${rng.pick(['Suresh Kalyan', 'Faiz Ahmed', 'Pallavi Rane', 'Dinesh Shetty', 'Anup Barman'])}`,
          `Vehicle: ${rng.pick(['Bajaj Pulsar 150', 'Tata Ace', 'Ashok Leyland Dost', 'Renault Kwid', 'Eicher 1109'])}`,
          `Registration: ${ctx.registration.slice(0, 5)}${rng.int(10, 99)}-${rng.pick(['AB', 'CJ', 'KP', 'ZQ'])}-${rng.int(1000, 9999)}`,
          `Insurer: ${rng.pick(['New India Assurance', 'ICICI Lombard', 'Bajaj Allianz', 'United India'])}`,
          `Policy number: ${rng.pick(['NIA', 'ICL', 'BAJ', 'UII'])}-${rng.int(1000000, 9999999)}`,
          `Contact: +91${rng.int(70, 99)}${rng.int(10000000, 99999999)}`,
        ].join('\n'),
      };

    case 'photos':
    case 'damage_photos':
      return {
        document_type: type,
        original_filename: `${type}_${ctx.incidentDate.replace(/-/g, '')}_${ref()}.jpg`,
        mime_type: MIME_JPEG,
        content: [
          `Set of ${rng.int(6, 18)} photographs.`,
          `EXIF DateTimeOriginal on the first frame: ${ctx.documentDate} ${String(rng.int(6, 21)).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}:00`,
          `Subject: ${ctx.summary}`,
          'Frames cover the damage from four sides plus two close-ups. No wider context frame supplied.',
        ].join('\n'),
      };

    case 'incident_report':
      return {
        document_type: type,
        original_filename: `incident_report_${ref()}.txt`,
        mime_type: MIME_TEXT,
        content: [
          'INCIDENT REPORT (completed by the insured)',
          `Date of occurrence: ${ctx.documentDate}`,
          `Reported by: ${ctx.customerName}`,
          '',
          `  ${ctx.summary}`,
        ].join('\n'),
      };

    default:
      return {
        document_type: type,
        original_filename: `${type}_${ref()}.txt`,
        mime_type: MIME_TEXT,
        content: [`Document of type ${type}.`, `Date of occurrence: ${ctx.documentDate}`, ctx.summary].join('\n'),
      };
  }
}
