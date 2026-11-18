/** the most questions one form asks, and the most a session's question or a coordinator's answer carries */
export const QUESTIONS_MAX = 4
/** the longest text of a question, in characters */
export const QUESTION_TEXT_MAX = 2000
/** the longest header (the short tag of a question), in characters */
export const QUESTION_HEADER_MAX = 50
/** the fewest and the most options a question offers */
export const OPTIONS_MIN = 2
export const OPTIONS_MAX = 4
/** the longest label and description of an option, in characters */
export const OPTION_LABEL_MAX = 200
export const OPTION_DESCRIPTION_MAX = 500
/** the longest question and answer a coordinator's form carries, in characters */
export const FORM_QUESTION_MAX = 2000
export const FORM_ANSWER_MAX = 2000

/** an option of a question the session asks the person */
export interface AskedOption {
  label: string
  description: string
}

/** a question the session asks the person, as AskUserQuestion gives it */
export interface AskedQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: AskedOption[]
}

/** a question the coordinator passes on: the session's question, the question as the coordinator asked it, and the person's answer */
export interface PassedAnswer {
  question: string
  asked: string
  answer: string
}

/** the questions of a session's AskUserQuestion as a checked copy with only their own fields; null when the list is out of bounds or a field is not valid */
export function parseQuestions(v: unknown): AskedQuestion[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > QUESTIONS_MAX) return null
  const questions: AskedQuestion[] = []
  for (const item of v) {
    const question = parseQuestion(item)
    if (question === null) return null
    questions.push(question)
  }
  // the questions of one form are told apart by their text
  if (new Set(questions.map((q) => q.question)).size !== questions.length) return null
  return questions
}

/** the person's answers to the questions of a coordinator as a checked copy; null when the list is out of bounds or a field is not valid */
export function parsePassedAnswers(v: unknown): PassedAnswer[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > QUESTIONS_MAX) return null
  const answers: PassedAnswer[] = []
  for (const item of v) {
    if (!isObject(item)) return null
    const { question, asked, answer } = item
    if (!sizedText(question, FORM_QUESTION_MAX) || !sizedText(asked, FORM_QUESTION_MAX) || !sizedText(answer, FORM_ANSWER_MAX)) return null
    answers.push({ question, asked, answer })
  }
  return answers
}

function parseQuestion(v: unknown): AskedQuestion | null {
  if (!isObject(v)) return null
  const { question, header, multiSelect, options } = v
  if (typeof question !== 'string' || question.trim() === '' || question.length > QUESTION_TEXT_MAX) return null
  const checkedHeader = header === undefined ? '' : header
  if (typeof checkedHeader !== 'string' || checkedHeader.length > QUESTION_HEADER_MAX) return null
  const checkedMulti = multiSelect === undefined ? false : multiSelect
  if (typeof checkedMulti !== 'boolean') return null
  if (!Array.isArray(options) || options.length < OPTIONS_MIN || options.length > OPTIONS_MAX) return null
  const checkedOptions: AskedOption[] = []
  for (const item of options) {
    const option = parseOption(item)
    if (option === null) return null
    checkedOptions.push(option)
  }
  return { question, header: checkedHeader, multiSelect: checkedMulti, options: checkedOptions }
}

function parseOption(v: unknown): AskedOption | null {
  if (!isObject(v)) return null
  const { label, description } = v
  if (!sizedText(label, OPTION_LABEL_MAX)) return null
  const checkedDescription = description === undefined ? '' : description
  if (typeof checkedDescription !== 'string' || checkedDescription.length > OPTION_DESCRIPTION_MAX) return null
  return { label, description: checkedDescription }
}

function sizedText(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= max
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
