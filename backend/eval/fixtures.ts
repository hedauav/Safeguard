/**
 * Raw material for the generator: people, policies, exclusion wordings and
 * narrative fragments.
 *
 * Names follow the convention of the seeded dataset in
 * `backend/database/run-all.sql`. None of these people appear there — the
 * evaluation set has to be disjoint from anything the system may have been
 * built against.
 */
import type { ClaimType, PolicyType } from './types.js';

export const GIVEN_NAMES = [
  'Aarav', 'Advait', 'Ishaan', 'Kabir', 'Reyansh', 'Vihaan', 'Devansh', 'Shaurya',
  'Aanya', 'Diya', 'Meher', 'Saanvi', 'Anvi', 'Ira', 'Myra', 'Riya',
  'Chirag', 'Suhas', 'Pranav', 'Yash', 'Nachiket', 'Girish', 'Mahesh', 'Sanjay',
  'Bhavna', 'Sudha', 'Rekha', 'Shalini', 'Aparna', 'Vaishali', 'Madhuri', 'Jyoti',
  'Zoya', 'Imran', 'Ayesha', 'Rizwan', 'Tejas', 'Ojas', 'Kiran', 'Neeraj',
] as const;

export const SURNAMES = [
  'Bhagat', 'Chatterjee', 'Dandekar', 'Fernandes', 'Ganguly', 'Hegde', 'Jadhav',
  'Kamath', 'Lohia', 'Mahadevan', 'Nagarajan', 'Oberoi', 'Purohit', 'Ranganathan',
  'Sundaram', 'Talwar', 'Ummat', 'Venkatesan', 'Wadhwa', 'Zaveri', 'Bakshi',
  'Chowdhury', 'Dsouza', 'Elangovan', 'Gokhale', 'Hiremath', 'Iyengar', 'Joglekar',
] as const;

export interface CitySpec {
  city: string;
  state: string;
  pinPrefix: string;
  roads: readonly string[];
  station: string;
}

export const CITIES: readonly CitySpec[] = [
  { city: 'Bengaluru', state: 'Karnataka', pinPrefix: '5600', station: 'Koramangala PS', roads: ['Sarjapur Road', 'Old Airport Road', 'Bannerghatta Road', '100 Feet Road, Indiranagar'] },
  { city: 'Pune', state: 'Maharashtra', pinPrefix: '4110', station: 'Chinchwad PS', roads: ['Baner Road', 'FC Road', 'Nagar Road', 'Sinhagad Road'] },
  { city: 'Mumbai', state: 'Maharashtra', pinPrefix: '4000', station: 'Powai PS', roads: ['Western Express Highway', 'LBS Marg', 'SV Road, Andheri', 'Eastern Freeway'] },
  { city: 'Hyderabad', state: 'Telangana', pinPrefix: '5000', station: 'Madhapur PS', roads: ['Outer Ring Road', 'Necklace Road', 'Gachibowli Flyover', 'Banjara Hills Road No. 12'] },
  { city: 'Chennai', state: 'Tamil Nadu', pinPrefix: '6000', station: 'Adyar PS', roads: ['Old Mahabalipuram Road', 'Anna Salai', 'ECR near Neelankarai', 'Poonamallee High Road'] },
  { city: 'Ahmedabad', state: 'Gujarat', pinPrefix: '3800', station: 'Vastrapur PS', roads: ['SG Highway', 'Ashram Road', 'CG Road', 'Sardar Patel Ring Road'] },
  { city: 'Kolkata', state: 'West Bengal', pinPrefix: '7000', station: 'Salt Lake PS', roads: ['EM Bypass', 'AJC Bose Road', 'VIP Road', 'Diamond Harbour Road'] },
  { city: 'Jaipur', state: 'Rajasthan', pinPrefix: '3020', station: 'Malviya Nagar PS', roads: ['Tonk Road', 'JLN Marg', 'Ajmer Road', 'Sikar Road'] },
  { city: 'Kochi', state: 'Kerala', pinPrefix: '6820', station: 'Palarivattom PS', roads: ['NH 66 near Edappally', 'MG Road', 'Seaport-Airport Road', 'Banerji Road'] },
  { city: 'Lucknow', state: 'Uttar Pradesh', pinPrefix: '2260', station: 'Gomti Nagar PS', roads: ['Shaheed Path', 'Faizabad Road', 'Kanpur Road', 'Gomti Nagar Vistar Road'] },
];

export const APARTMENTS = [
  'Brigade Gateway', 'Prestige Lakeside', 'Kalpataru Serenity', 'Godrej Woodsman',
  'Sobha Dewflower', 'Purva Riviera', 'Lodha Belmondo', 'Rohan Abhilasha',
  'Casa Grande Orchid', 'Mantri Espana', 'Ashiana Umang', 'Sunteck City',
] as const;

export const VEHICLES = [
  { model: 'Maruti Suzuki Baleno', year: 2022 },
  { model: 'Hyundai Creta', year: 2023 },
  { model: 'Tata Nexon EV', year: 2024 },
  { model: 'Honda City', year: 2021 },
  { model: 'Mahindra XUV700', year: 2023 },
  { model: 'Kia Seltos', year: 2022 },
  { model: 'Toyota Innova Crysta', year: 2020 },
  { model: 'Skoda Slavia', year: 2023 },
  { model: 'Maruti Suzuki Swift', year: 2021 },
  { model: 'MG Hector', year: 2022 },
] as const;

export const GARAGES = [
  'Sai Auto Works', 'Kalyani Motors Service', 'Prime Wheels Bodyshop',
  'Meridian Auto Care', 'Shreeji Automobiles', 'Southern Motors Workshop',
] as const;

export const CONTRACTORS = [
  'Anmol Interiors and Restoration', 'Rebuild Solutions Pvt Ltd', 'Sunrise Civil Works',
  'Nirman Restoration Services', 'Sharada Constructions',
] as const;

export const HOSPITALS = [
  'Manipal Hospital', 'Kokilaben Ambani Hospital', 'Apollo Speciality Hospital',
  'Fortis Memorial Institute', 'Rainbow Childrens Hospital', 'Narayana Health City',
] as const;

/**
 * Exclusion wordings, per policy type.
 *
 * `applies_core` describes an incident the clause plainly covers; `near_miss_core`
 * describes an incident the clause is adjacent to and does not reach. The pair is
 * the whole point — an adjudicator that fires on the word "water" rather than on
 * the word "flood" will get exactly half of these wrong.
 */
export interface ExclusionSpec {
  clause: string;
  claim_type: ClaimType;
  applies_core: string;
  near_miss_core: string;
  /** One line saying why the near miss is not caught by the clause. */
  near_miss_reason: string;
}

export const EXCLUSIONS: Record<PolicyType, readonly ExclusionSpec[]> = {
  auto: [
    {
      clause: 'Section 4.2 — Road hazard: damage from potholes, kerbs, speed breakers and unmade road surfaces',
      claim_type: 'collision',
      applies_core:
        'The front-left wheel and lower suspension arm were damaged after the car dropped into an unmarked pothole roughly two feet across',
      near_miss_core:
        'The front-left wheel and lower suspension arm were damaged when a municipal water tanker reversed into the stationary car at a junction',
      near_miss_reason: 'the damage came from another vehicle, not from the road surface',
    },
    {
      clause: 'Section 4.5 — Wear and tear: mechanical or electrical breakdown, corrosion and gradual deterioration',
      claim_type: 'comprehensive',
      applies_core:
        'The gearbox began slipping over several months and finally failed on the highway, with no impact of any kind involved',
      near_miss_core:
        'The gearbox housing cracked when the underbody struck a dislodged manhole cover thrown up by the vehicle in front',
      near_miss_reason: 'the failure came from a single external impact, not from gradual deterioration',
    },
    {
      clause: 'Section 4.9 — Driving without a valid licence or under the influence of alcohol or drugs',
      claim_type: 'collision',
      applies_core:
        'The driver at the time of the collision held a learner permit only and was unaccompanied, which the traffic police recorded at the scene',
      near_miss_core:
        'The driver at the time of the collision held a full licence that had expired eleven days earlier and was renewed the same week',
      near_miss_reason: 'an expired but renewable licence is not driving unlicensed under this wording',
    },
    {
      clause: 'Section 4.11 — Vehicle used for hire or reward while rated for private use',
      claim_type: 'collision',
      applies_core:
        'The car was carrying a paying passenger booked through a ride-hailing app when the collision occurred, and the trip receipt is on the driver phone',
      near_miss_core:
        'The car was carrying two colleagues on a shared office commute when the collision occurred, with no fare charged and no booking involved',
      near_miss_reason: 'a private car pool is not hire or reward',
    },
  ],
  home: [
    {
      clause: 'Section 6.1 — Flood, inundation and rising external water',
      claim_type: 'water_damage',
      applies_core:
        'Storm water rose from the road and entered the ground-floor rooms to a depth of about eighteen inches during two days of heavy rain',
      near_miss_core:
        'A pressurised inlet pipe behind the geyser burst and flooded the bathroom, passage and one bedroom before the mains could be shut off',
      near_miss_reason: 'the water came from the building plumbing, not from outside the building',
    },
    {
      clause: 'Section 6.4 — Damage from inadequate maintenance, long-standing seepage or unrepaired defects',
      claim_type: 'water_damage',
      applies_core:
        'Damp had been spreading through the bedroom wall for at least two monsoons and the ceiling plaster finally came away in sheets',
      near_miss_core:
        'A roof tile lifted in a single squall and rain entered the bedroom overnight, bringing down a section of ceiling plaster',
      near_miss_reason: 'a single storm event is not long-standing seepage',
    },
    {
      clause: 'Section 6.7 — Theft from a property left unoccupied for more than thirty consecutive days',
      claim_type: 'theft',
      applies_core:
        'The flat had been locked and empty for about seven weeks while the family was abroad when the break-in was discovered',
      near_miss_core:
        'The flat had been locked and empty for nine days over a festival break when the break-in was discovered',
      near_miss_reason: 'nine days is well inside the thirty-day limit the clause sets',
    },
    {
      clause: 'Section 6.9 — Fire originating from unauthorised alterations to the electrical installation',
      claim_type: 'fire_damage',
      applies_core:
        'The fire started at a spur the previous occupant had run off the lighting circuit to feed a window air-conditioner, which the inspection report describes as unauthorised',
      near_miss_core:
        'The fire started at the sanctioned kitchen socket where a licensed electrician had installed the chimney point four years earlier',
      near_miss_reason: 'the installation was sanctioned and certified, so the alteration clause does not reach it',
    },
  ],
  health: [
    {
      clause: 'Section 8.3 — Cosmetic and elective procedures not arising from illness or injury',
      claim_type: 'medical',
      applies_core:
        'The admission was for an elective rhinoplasty booked six weeks in advance, with no injury or illness recorded anywhere in the file',
      near_miss_core:
        'The admission was for reconstruction of the nasal bridge after a fracture sustained in a two-wheeler fall, documented by the treating surgeon',
      near_miss_reason: 'reconstruction after a documented injury is not a cosmetic procedure',
    },
    {
      clause: 'Section 8.6 — Pre-existing conditions during the first twenty-four months of cover',
      claim_type: 'medical',
      applies_core:
        'The admission was for the same diabetic foot ulcer disclosed on the proposal form, and the policy is fourteen months old',
      near_miss_core:
        'The admission was for appendicitis unrelated to the diabetes disclosed on the proposal form, and the policy is fourteen months old',
      near_miss_reason: 'the condition treated is unrelated to anything disclosed as pre-existing',
    },
    {
      clause: 'Section 8.8 — Treatment outside the policy network without prior authorisation in a non-emergency',
      claim_type: 'medical',
      applies_core:
        'The planned knee replacement was carried out at an out-of-network hospital chosen by the family, with no authorisation sought beforehand',
      near_miss_core:
        'The emergency appendectomy was carried out at the nearest out-of-network hospital at two in the morning, with the insurer informed the same day',
      near_miss_reason: 'the clause carves out emergencies, and this admission was one',
    },
  ],
};

/** Claim types that make sense on each kind of policy. */
export const CLAIM_TYPES_BY_POLICY: Record<PolicyType, readonly ClaimType[]> = {
  auto: ['collision', 'windshield', 'theft', 'comprehensive'],
  home: ['water_damage', 'fire_damage', 'theft', 'comprehensive'],
  health: ['medical'],
};

/** `getDefaultDocuments` in `backend/src/services/claims-service.ts`, verbatim. */
export const DEFAULT_DOCUMENTS: Record<string, readonly string[]> = {
  collision: ['police_report', 'repair_estimate', 'photos', 'other_driver_info'],
  windshield: ['photos', 'repair_estimate'],
  theft: ['police_report', 'proof_of_purchase', 'photos'],
  water_damage: ['plumber_invoice', 'damage_photos', 'contractor_estimate'],
  fire_damage: ['fire_dept_report', 'contractor_estimates', 'photos'],
  medical: ['medical_records', 'itemized_bill', 'referral_letter'],
  comprehensive: ['photos', 'repair_estimate', 'incident_report'],
};

export function documentsRequired(claimType: ClaimType): string[] {
  return [...(DEFAULT_DOCUMENTS[claimType] ?? ['photos', 'incident_report'])];
}

/**
 * Which document type carries a money total for each claim type, and which
 * carries a date of occurrence. These are the two documents a contradiction is
 * planted in.
 */
export const ESTIMATE_DOCUMENT: Record<ClaimType, string> = {
  collision: 'repair_estimate',
  windshield: 'repair_estimate',
  theft: 'proof_of_purchase',
  water_damage: 'contractor_estimate',
  fire_damage: 'contractor_estimates',
  medical: 'itemized_bill',
  comprehensive: 'repair_estimate',
};

export const REPORT_DOCUMENT: Partial<Record<ClaimType, string>> = {
  collision: 'police_report',
  theft: 'police_report',
  fire_damage: 'fire_dept_report',
};

/** Rupee bands, per policy type. */
export const POLICY_BANDS: Record<
  PolicyType,
  { coverage: [number, number]; deductible: [number, number]; premium: [number, number] }
> = {
  auto: { coverage: [350_000, 1_200_000], deductible: [5_000, 25_000], premium: [1_400, 4_200] },
  home: { coverage: [1_500_000, 9_000_000], deductible: [10_000, 50_000], premium: [900, 3_500] },
  health: { coverage: [300_000, 2_500_000], deductible: [5_000, 25_000], premium: [1_800, 6_500] },
};

/** Plausible claim size, per claim type. */
export const CLAIM_BANDS: Record<ClaimType, [number, number]> = {
  collision: [25_000, 450_000],
  windshield: [8_000, 35_000],
  theft: [60_000, 800_000],
  water_damage: [40_000, 600_000],
  fire_damage: [150_000, 2_500_000],
  medical: [20_000, 800_000],
  comprehensive: [20_000, 200_000],
};

/** Ordinary, unremarkable incident cores — the cases that are meant to be easy. */
export const PLAIN_CORES: Record<ClaimType, readonly string[]> = {
  collision: [
    'A car turning across the junction failed to give way and struck the front-right wing while the vehicle was going straight through on a green signal',
    'The vehicle was rear-ended at a signal by a delivery van that did not brake in time, damaging the boot lid, rear bumper and both tail lamps',
    'A two-wheeler lost control on wet tarmac and slid into the driver-side doors of the car, which was stationary in a queue of traffic',
  ],
  windshield: [
    'A stone thrown up by a tipper truck cracked the windscreen across the driver line of sight, leaving a spread of roughly nine inches',
    'The windscreen developed a full-width crack from a chip that spread overnight, and the glazier has ruled out a repair',
  ],
  theft: [
    'The vehicle was taken from the basement parking of the office building overnight, and the security footage shows it leaving at 01:14',
    'A locked cupboard in the bedroom was forced open and jewellery, a laptop and cash were taken while the family was out for the evening',
  ],
  water_damage: [
    'A supply line under the kitchen sink split and ran for several hours while the flat was empty, soaking the cabinets, skirting and the flooring in the adjoining passage',
    'The overhead tank overflowed through the night after the float valve jammed, and water tracked down the internal wall into the living room ceiling',
  ],
  fire_damage: [
    'A short circuit in the utility area started a fire that spread to the adjoining store room before the building fire team put it out',
    'A cooking fire caught the extractor hood and the fire brigade attended within twenty minutes, by which time the kitchen units and ceiling were gone',
  ],
  medical: [
    'The insured was admitted through emergency with acute cholecystitis and underwent a laparoscopic cholecystectomy the following morning',
    'The insured was admitted for three nights with dengue and severe thrombocytopenia and required two platelet transfusions',
  ],
  comprehensive: [
    'A branch came down in a squall onto the parked car, denting the roof, bonnet and both front wings',
    'The vehicle was damaged by falling debris from scaffolding on the building it was parked beside, and the site supervisor has accepted responsibility in writing',
  ],
};

/**
 * Incident cores whose evidence genuinely does not settle the question. These
 * are the cases whose honest label is `escalate` — not because a trap was
 * planted, but because a careful human reading the file would also want more.
 */
export const AMBIGUOUS_CORES: Record<string, { core: string; why: string }[]> = {
  theft: [
    {
      core:
        'A laptop bag was missing from the back seat of the car after a two-hour stop at a restaurant, and the insured is not certain whether the doors were locked. There is no sign of forced entry and no CCTV covering that part of the car park',
      why: 'nothing on file distinguishes theft from a bag left behind somewhere else',
    },
    {
      core:
        'Gold ornaments kept in a bedroom drawer were found missing after a week in which painters, a plumber and two relatives had access to the flat. No lock was broken and nothing else was disturbed',
      why: 'the record cannot separate a theft from a misplacement among several people with access',
    },
  ],
  water_damage: [
    {
      core:
        'Staining appeared across the bedroom ceiling after a week of rain. The plumber says the leak is at the terrace waterproofing above and the society says the flat above overflowed a tank, and the two accounts have not been reconciled',
      why: 'the cause decides whether the loss falls to the policy or to the society, and the two reports disagree',
    },
  ],
  medical: [
    {
      core:
        'The insured was admitted for two nights of observation after chest pain that resolved without intervention. The discharge summary records a non-cardiac cause and the treating physician has not stated whether the admission was medically necessary or precautionary',
      why: 'medical necessity is the whole question and the file does not answer it',
    },
    {
      core:
        'The hospital has billed a two-week course of physiotherapy as inpatient care while the daily notes describe the insured leaving the premises each evening',
      why: 'the record is inconsistent about whether this was inpatient treatment at all',
    },
  ],
  collision: [
    {
      core:
        'Both drivers say the other crossed the centre line on an unmarked stretch of road at dusk. There were no witnesses, the road has no camera, and the damage pattern is consistent with either account',
      why: 'liability cannot be settled from the file, and the payout depends on it',
    },
  ],
};

/**
 * Circumstance and aftermath sentences, kept separate per policy type.
 *
 * A shared pool produced filings that told a claims handler the vehicle was
 * off the road after a burst pipe. Descriptions have to read like something a
 * person actually filed, or the difficulty of a case stops being the thing
 * under test.
 */
export const CIRCUMSTANCES: Record<PolicyType, readonly string[]> = {
  auto: [
    'No injuries were reported.',
    'Two people who saw it happen have given their contact details.',
    'Nothing was moved until the traffic constable at the junction had seen the position of the vehicles.',
    'The insured photographed the damage before the vehicle was moved.',
    'The vehicle is used by the insured and one other family member, both named on the policy.',
  ],
  home: [
    'The insured was not at home at the time and was informed by the building manager.',
    'The society secretary attended within the hour and has recorded it in the register.',
    'Two neighbours on the same floor have given statements.',
    'The insured photographed the affected rooms before anything was moved.',
    'The maintenance staff shut off the mains and cleared the standing water the same evening.',
  ],
  health: [
    'The insured was accompanied by a family member throughout the admission.',
    'Pre-authorisation was not sought because the admission was through the emergency department.',
    'The treating consultant has agreed to answer any queries the insurer raises.',
    'The insured has settled the hospital bill and is claiming reimbursement.',
    'The employer group scheme was informed but has not been claimed against.',
  ],
};

export const AFTERMATH: Record<PolicyType, readonly string[]> = {
  auto: [
    'The vehicle is off the road pending assessment.',
    'The vehicle has been moved to the workshop and is awaiting a surveyor visit.',
    'No repair has been authorised yet and the insured is asking how long the assessment will take.',
    'The insured is using a hired vehicle in the meantime and has not claimed for it.',
  ],
  home: [
    'Temporary repairs have been carried out to make the property secure.',
    'The affected room remains unusable and the family is using the rest of the flat.',
    'Nothing has been repaired or replaced yet, pending the surveyor visit.',
    'The insured has asked how long the assessment is likely to take.',
  ],
  health: [
    'The insured was discharged and is recovering at home.',
    'A follow-up review is scheduled and has not been claimed for.',
    'The insured has asked how long reimbursement usually takes.',
    'No further admission is expected in relation to this episode.',
  ],
};

/**
 * Vehicle theft does not sit under the general auto wording: a stolen car is
 * not "off the road pending assessment", and a filing that says so reads as
 * boilerplate rather than as something a person wrote.
 */
export const AUTO_THEFT_CIRCUMSTANCES: readonly string[] = [
  'Both sets of keys are with the insured and have been offered to the surveyor.',
  'The building security guard on duty has given a statement.',
  'The insured reported the loss to the police the same day.',
  'The vehicle was not fitted with a tracking device.',
];

export const AUTO_THEFT_AFTERMATH: readonly string[] = [
  'The vehicle has not been recovered and the police enquiry is open.',
  'The insured is asking what happens if the vehicle is recovered after settlement.',
  'The registration authority has been informed and the intimation is on file.',
  'No claim has been made against any other policy for this loss.',
];
