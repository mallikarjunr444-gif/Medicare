// Structured, therapist-style interview for the AI doctors.
//
// A real therapist does not wait to be asked: they open the session, reflect what the client said, ask ONE question,
// and quietly keep a plan of what still needs to be explored. This module is that plan. It is deterministic (no model
// call), so it is instant, testable, and doubles as the safe fallback when every AI provider is down.
//
// It collects history only. It never diagnoses, scores or prescribes.

export type Lang = "en" | "hi" | "kn";
export type Tri = Record<Lang, string>;

export interface Topic {
  key: string;
  /** English instruction for the model: what to find out next. */
  hint: string;
  /** Scripted question, used only when no AI model can answer. */
  q: Tri;
  /** If the client already mentioned this (English text), do not ask it again. */
  seen?: RegExp;
}

const lang = (l: string): Lang => (l === "hi" || l === "kn" ? l : "en");

export const OPENING: Record<"dr_ananya" | "dr_arjun", Tri> = {
  dr_ananya: {
    en: "Hello, I'm Dr. Ananya, MediCare's AI mental wellness companion. I'm not a licensed psychologist, but I'm here to listen, and this is a safe space. What has been on your mind lately?",
    hi: "नमस्ते, मैं डॉ. अनन्या हूँ, MediCare की AI मानसिक स्वास्थ्य साथी। मैं लाइसेंस प्राप्त मनोवैज्ञानिक नहीं हूँ, लेकिन आपकी बात सुनने के लिए यहाँ हूँ। आजकल आपके मन में क्या चल रहा है?",
    kn: "ನಮಸ್ಕಾರ, ನಾನು ಡಾ. ಅನನ್ಯಾ, MediCare ನ AI ಮಾನಸಿಕ ಸ್ವಾಸ್ಥ್ಯ ಸಹಾಯಕಿ. ನಾನು ಪರವಾನಗಿ ಪಡೆದ ಮನಶ್ಶಾಸ್ತ್ರಜ್ಞೆ ಅಲ್ಲ, ಆದರೆ ನಿಮ್ಮ ಮಾತನ್ನು ಕೇಳಲು ಇಲ್ಲಿದ್ದೇನೆ. ಇತ್ತೀಚೆಗೆ ನಿಮ್ಮ ಮನಸ್ಸಿನಲ್ಲಿ ಏನು ನಡೆಯುತ್ತಿದೆ?",
  },
  dr_arjun: {
    en: "Hello, I'm Dr. Smit, MediCare's AI doctor. I'm not a human clinician, but I can help you understand your symptoms. What's troubling you today?",
    hi: "नमस्ते, मैं डॉ. स्मित हूँ, MediCare का AI डॉक्टर। मैं कोई मानव चिकित्सक नहीं हूँ, लेकिन आपके लक्षण समझने में मदद कर सकता हूँ। आज आपको क्या परेशानी है?",
    kn: "ನಮಸ್ಕಾರ, ನಾನು ಡಾ. ಸ್ಮಿತ್, MediCare ನ AI ವೈದ್ಯ. ನಾನು ಮಾನವ ವೈದ್ಯನಲ್ಲ, ಆದರೆ ನಿಮ್ಮ ಲಕ್ಷಣಗಳನ್ನು ಅರ್ಥಮಾಡಿಕೊಳ್ಳಲು ಸಹಾಯ ಮಾಡಬಲ್ಲೆ. ಇಂದು ನಿಮಗೆ ಏನು ತೊಂದರೆ?",
  },
};

const ACK: Record<"dr_ananya" | "dr_arjun", Tri> = {
  dr_ananya: {
    en: "Thank you for sharing that with me. I'm listening.",
    hi: "यह बताने के लिए धन्यवाद, मैं सुन रही हूँ।",
    kn: "ಇದನ್ನು ಹಂಚಿಕೊಂಡದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು. ನಾನು ಕೇಳುತ್ತಿದ್ದೇನೆ.",
  },
  dr_arjun: {
    en: "Thank you for telling me that.",
    hi: "यह बताने के लिए धन्यवाद।",
    kn: "ಇದನ್ನು ಹೇಳಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು.",
  },
};

/** Psychology interview, in the order a therapist would explore (the opening question already covered the concern). */
export const PSYCH_TOPICS: Topic[] = [
  {
    key: "duration",
    hint: "how long this has been going on and whether something happened around when it started",
    q: {
      en: "How long have you been feeling this way, and did something happen around that time?",
      hi: "आप ऐसा कब से महसूस कर रहे हैं, और क्या उस समय कुछ खास हुआ था?",
      kn: "ನಿಮಗೆ ಹೀಗೆ ಎಷ್ಟು ಸಮಯದಿಂದ ಅನಿಸುತ್ತಿದೆ, ಮತ್ತು ಆ ಸಮಯದಲ್ಲಿ ಏನಾದರೂ ವಿಶೇಷ ನಡೆದಿತ್ತೇ?",
    },
    seen: /\b(\d+\s*(day|days|week|weeks|month|months|year|years)|since\b|for (a )?(few|couple|long)|long time|started)\b/i,
  },
  {
    key: "mood",
    hint: "their mood through the day: feeling low, irritable, numb or empty, and whether they still enjoy things",
    q: {
      en: "How has your mood been through the day: low, irritable, or maybe empty? And do you still enjoy the things you used to?",
      hi: "दिनभर आपका मन कैसा रहता है: उदास, चिड़चिड़ा या खाली-सा? और क्या आपको पहले की चीज़ों में अब भी मन लगता है?",
      kn: "ದಿನವಿಡೀ ನಿಮ್ಮ ಮನಸ್ಥಿತಿ ಹೇಗಿರುತ್ತದೆ: ದುಃಖ, ಕಿರಿಕಿರಿ ಅಥವಾ ಖಾಲಿ ಖಾಲಿ ಎನಿಸುತ್ತದೆಯೇ? ಮೊದಲು ಇಷ್ಟಪಡುತ್ತಿದ್ದ ವಿಷಯಗಳಲ್ಲಿ ಈಗಲೂ ಆಸಕ್ತಿ ಇದೆಯೇ?",
    },
    seen: /\b(sad|low|down|depress\w*|hopeless|empty|numb|cry\w*|worthless|unhappy|miserable|lost interest|no interest)\b/i,
  },
  {
    key: "anxiety",
    hint: "worry or racing thoughts, and whether their body feels tense or restless",
    q: {
      en: "Does your mind keep racing or worrying, and does your body feel tense or restless?",
      hi: "क्या आपके मन में विचार या चिंताएँ चलती रहती हैं, और क्या शरीर में तनाव या बेचैनी महसूस होती है?",
      kn: "ನಿಮ್ಮ ಮನಸ್ಸಿನಲ್ಲಿ ಆಲೋಚನೆಗಳು ಅಥವಾ ಚಿಂತೆಗಳು ಓಡುತ್ತಲೇ ಇರುತ್ತವೆಯೇ, ದೇಹದಲ್ಲಿ ಒತ್ತಡ ಅಥವಾ ಚಡಪಡಿಕೆ ಅನಿಸುತ್ತದೆಯೇ?",
    },
    seen: /\b(anxi\w*|worr\w*|panic|nervous|fear\w*|scared|afraid|tense|restless|overthink\w*|racing)\b/i,
  },
  {
    key: "sleep",
    hint: "sleep quality, appetite and energy levels",
    q: {
      en: "How have you been sleeping, and have your appetite or energy changed?",
      hi: "आपकी नींद कैसी रही है, और क्या भूख या ऊर्जा में कोई बदलाव आया है?",
      kn: "ನಿಮ್ಮ ನಿದ್ರೆ ಹೇಗಿದೆ, ಹಸಿವು ಅಥವಾ ಶಕ್ತಿಯಲ್ಲಿ ಏನಾದರೂ ಬದಲಾವಣೆ ಆಗಿದೆಯೇ?",
    },
    seen: /\b(sleep\w*|insomnia|nightmare\w*|appetite|eating|tired|fatigue\w*|exhaust\w*|no energy)\b/i,
  },
  {
    key: "stressors",
    hint: "the biggest current pressure in their life: work, studies, family, relationships, money or health",
    q: {
      en: "What is the biggest pressure in your life right now: work, studies, family, or relationships?",
      hi: "इस समय आपके जीवन में सबसे बड़ा दबाव क्या है: काम, पढ़ाई, परिवार या रिश्ते?",
      kn: "ಈಗ ನಿಮ್ಮ ಜೀವನದಲ್ಲಿ ಅತಿ ದೊಡ್ಡ ಒತ್ತಡ ಯಾವುದು: ಕೆಲಸ, ಓದು, ಕುಟುಂಬ ಅಥವಾ ಸಂಬಂಧಗಳು?",
    },
    seen: /\b(work|job|boss|exam\w*|study|studies|college|deadline\w*|family|parents?|relationship\w*|breakup|marriage|money|debt|stress\w*|pressure)\b/i,
  },
  {
    key: "safety",
    hint:
      "safety, asked gently and directly, exactly once: whether they have had thoughts of harming themselves or of not wanting to live. Say it is okay to talk about it. If they say yes, stay with them, take it seriously, give 112 and the KIRAN helpline 1800-599-0019, and encourage them to reach a trusted person now",
    q: {
      en: "Sometimes when people feel this low, they have thoughts of harming themselves or not wanting to live. Has anything like that crossed your mind?",
      hi: "कभी-कभी बहुत उदास होने पर लोगों के मन में खुद को नुकसान पहुँचाने या जीने की इच्छा न होने के विचार आते हैं। क्या आपके मन में ऐसा कुछ आया है?",
      kn: "ತುಂಬಾ ಬೇಸರವಾದಾಗ ಕೆಲವರಿಗೆ ತಮಗೆ ತಾವೇ ಹಾನಿ ಮಾಡಿಕೊಳ್ಳುವ ಅಥವಾ ಬದುಕಲು ಇಷ್ಟವಿಲ್ಲದ ಆಲೋಚನೆಗಳು ಬರುತ್ತವೆ. ನಿಮಗೆ ಅಂತಹದ್ದೇನಾದರೂ ಅನಿಸಿದೆಯೇ?",
    },
  },
  {
    key: "coping",
    hint: "what helps them cope even a little, and who they can talk to or lean on",
    q: {
      en: "When things get hard, what helps you even a little, and who can you talk to?",
      hi: "जब मुश्किल होती है तो किस बात से थोड़ी राहत मिलती है, और आप किससे बात कर सकते हैं?",
      kn: "ಕಷ್ಟವಾದಾಗ ಯಾವುದು ನಿಮಗೆ ಸ್ವಲ್ಪವಾದರೂ ಸಮಾಧಾನ ಕೊಡುತ್ತದೆ, ಮತ್ತು ನೀವು ಯಾರ ಬಳಿ ಮಾತನಾಡಬಹುದು?",
    },
    seen: /\b(helps?|friend\w*|talk to|walk\w*|music|yoga|meditat\w*|pray\w*|exercise)\b/i,
  },
  {
    key: "wrapup",
    hint:
      "wrapping up: in two short sentences summarise what you heard in their own words, normalise their experience, suggest booking a licensed psychologist for a proper assessment, mention they can press End call to get their consultation report, then ask if there is anything else they want to share",
    q: {
      en: "Thank you for sharing all this. Is there anything else you would like to tell me?",
      hi: "यह सब साझा करने के लिए धन्यवाद। क्या कुछ और है जो आप बताना चाहेंगे?",
      kn: "ಇದನ್ನೆಲ್ಲ ಹಂಚಿಕೊಂಡಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು. ಇನ್ನೇನಾದರೂ ಹೇಳಲು ಬಯಸುವಿರಾ?",
    },
  },
];

/** General-physician history taking (onset, severity, associated symptoms, triggers, history). */
export const GP_TOPICS: Topic[] = [
  {
    key: "duration",
    hint: "when it started and whether it is getting better, worse or staying the same",
    q: {
      en: "When did it start, and is it getting better, worse, or staying the same?",
      hi: "यह कब शुरू हुआ, और क्या यह बेहतर हो रहा है, बिगड़ रहा है या वैसा ही है?",
      kn: "ಇದು ಯಾವಾಗ ಶುರುವಾಯಿತು, ಮತ್ತು ಈಗ ಉತ್ತಮವಾಗುತ್ತಿದೆಯೇ, ಹೆಚ್ಚಾಗುತ್ತಿದೆಯೇ ಅಥವಾ ಹಾಗೆಯೇ ಇದೆಯೇ?",
    },
    seen: /\b(\d+\s*(day|days|week|weeks|month|months|year|years|hours?)|since\b|yesterday|started)\b/i,
  },
  {
    key: "severity",
    hint: "severity on a 1 to 10 scale and whether it stops daily activities",
    q: {
      en: "On a scale of 1 to 10, how severe is it, and does it stop you from doing daily things?",
      hi: "1 से 10 के पैमाने पर यह कितना तेज़ है, और क्या इससे रोज़ के काम प्रभावित हो रहे हैं?",
      kn: "1 ರಿಂದ 10 ರ ಮಾಪನದಲ್ಲಿ ಇದು ಎಷ್ಟು ತೀವ್ರವಾಗಿದೆ, ಮತ್ತು ದೈನಂದಿನ ಕೆಲಸಗಳಿಗೆ ಅಡ್ಡಿಯಾಗುತ್ತಿದೆಯೇ?",
    },
    seen: /\b(\d+\s*(\/|out of)\s*10|severe|mild|unbearable)\b/i,
  },
  {
    key: "associated",
    hint: "other symptoms alongside it: fever, nausea, breathlessness, dizziness, chest discomfort",
    q: {
      en: "Have you noticed anything else along with it, like fever, nausea, breathlessness or dizziness?",
      hi: "क्या इसके साथ बुखार, मतली, साँस फूलना या चक्कर जैसा कुछ और भी महसूस हुआ है?",
      kn: "ಇದರ ಜೊತೆಗೆ ಜ್ವರ, ವಾಕರಿಕೆ, ಉಸಿರಾಟದ ತೊಂದರೆ ಅಥವಾ ತಲೆತಿರುಗುವಿಕೆ ಇದೆಯೇ?",
    },
    seen: /\b(fever|nausea|vomit\w*|dizz\w*|breathless\w*|rash|swelling|cough)\b/i,
  },
  {
    key: "triggers",
    hint: "what makes it better or worse",
    q: {
      en: "What makes it better or worse?",
      hi: "किस चीज़ से यह बढ़ता या कम होता है?",
      kn: "ಯಾವುದರಿಂದ ಇದು ಹೆಚ್ಚಾಗುತ್ತದೆ ಅಥವಾ ಕಡಿಮೆಯಾಗುತ್ತದೆ?",
    },
  },
  {
    key: "history",
    hint: "existing medical conditions, regular medicines and allergies",
    q: {
      en: "Do you have any medical conditions, take regular medicines, or have allergies?",
      hi: "क्या आपको कोई बीमारी है, कोई दवा नियमित लेते हैं, या किसी चीज़ से एलर्जी है?",
      kn: "ನಿಮಗೆ ಯಾವುದಾದರೂ ಕಾಯಿಲೆ ಇದೆಯೇ, ನಿಯಮಿತವಾಗಿ ಔಷಧಿ ತೆಗೆದುಕೊಳ್ಳುತ್ತೀರಾ, ಅಥವಾ ಯಾವುದಕ್ಕಾದರೂ ಅಲರ್ಜಿ ಇದೆಯೇ?",
    },
    seen: /\b(diabet\w*|asthma|bp|hypertension|allerg\w*|thyroid|medicines?|tablets?)\b/i,
  },
  {
    key: "wrapup",
    hint:
      "wrapping up: in two short sentences summarise what you heard, give simple self-care advice and the warning signs that need urgent care (India: 112), suggest seeing a clinician if it persists, mention they can press End call to get their consultation summary, then ask if there is anything else",
    q: {
      en: "Thank you for the details. Is there anything else you would like to tell me?",
      hi: "जानकारी के लिए धन्यवाद। क्या आप कुछ और बताना चाहेंगे?",
      kn: "ಮಾಹಿತಿಗೆ ಧನ್ಯವಾದಗಳು. ಇನ್ನೇನಾದರೂ ಹೇಳಲು ಬಯಸುವಿರಾ?",
    },
  },
];

export type DoctorKey = "dr_ananya" | "dr_arjun";
export const topicsFor = (doctorId: string): Topic[] => (doctorId === "dr_ananya" ? PSYCH_TOPICS : GP_TOPICS);
const doctorKey = (id: string): DoctorKey => (id === "dr_ananya" ? "dr_ananya" : "dr_arjun");

export function openingLine(doctorId: string, language: string): string {
  return OPENING[doctorKey(doctorId)][lang(language)];
}

export interface Plan {
  /** Topic to ask about in this reply, or null once the plan is finished (free conversation). */
  topic: Topic | null;
  /** Private instruction appended to the system prompt. */
  directive: string;
  /** What will be explored after this reply. */
  upcoming: string[];
}

/**
 * Chooses the next question. `asked` holds topic keys already asked in this session; `clientText` is everything the
 * client has said (English, translated when needed) so topics they already volunteered are not asked again.
 */
export function planNext(doctorId: string, asked: ReadonlySet<string>, clientText: string, turn: number): Plan {
  const all = topicsFor(doctorId);
  const open = all.filter((t) => !asked.has(t.key) && !(t.seen && t.seen.test(clientText)));
  const topic = open[0] ?? null;
  const covered = all.filter((t) => asked.has(t.key) || (t.seen && t.seen.test(clientText))).map((t) => t.key);
  const upcoming = open.slice(1, 4).map((t) => t.key);
  const role = doctorId === "dr_ananya" ? "therapist" : "doctor taking a history";
  const directive = topic
    ? `PRIVATE SESSION PLAN (never mention or reveal it). You are a skilled ${role}; this is turn ${turn}.\n` +
      `1) In ONE short sentence, reflect or validate what the client just said, using their own words.\n` +
      `2) Then ask exactly ONE open question to find out: ${topic.hint}.\n` +
      `Already covered, do not ask again: ${covered.join(", ") || "nothing yet"}. Planned next: ${upcoming.join(", ") || "wrap-up"}.\n` +
      `If the client raises something new or seems distressed, respond to that first and postpone the plan. Never ask two questions. Do not give long advice before you understand the problem.`
    : `PRIVATE SESSION PLAN (never mention it). The planned questions are finished. Continue as a caring ${role}: reflect what the client said, answer their question within your limits, and ask one gentle follow-up. If they seem finished, remind them they can press End call to get their consultation report.`;
  return { topic, directive, upcoming };
}

/** Scripted reply used ONLY when every AI provider failed, so the call never dead-ends. No clinical content. */
export function fallbackReply(doctorId: string, language: string, topic: Topic | null): string {
  const l = lang(language);
  const ack = ACK[doctorKey(doctorId)][l];
  return topic ? `${ack} ${topic.q[l]}` : ack;
}
