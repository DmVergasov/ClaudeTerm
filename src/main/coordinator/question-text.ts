import type { AskedQuestion, PassedAnswer } from '../../shared/questions'

/**
 * The body of a question record: each question numbered from 1, with its header in brackets and how many answers it takes, then one
 * line per option with its description. The coordinator reads it quoted in the question's wake block.
 */
export function questionsBody(qs: readonly AskedQuestion[]): string {
  const lines: string[] = []
  qs.forEach((q, i) => {
    const header = q.header ? `[${q.header}] ` : ''
    lines.push(`${i + 1}. ${header}${q.question}  (${q.multiSelect ? 'several answers' : 'one answer'})`)
    for (const o of q.options) lines.push(`   - ${o.label}${o.description ? `: ${o.description}` : ''}`)
  })
  return lines.join('\n')
}

/** The body of an answer record: each question the session asked, numbered from 1, with the person's answer under it */
export function answersBody(answers: readonly PassedAnswer[]): string {
  return answers.map((a, i) => `${i + 1}. ${a.question}\n   The person answered: ${a.answer}`).join('\n')
}
