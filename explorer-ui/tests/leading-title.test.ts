import { describe, expect, it } from 'vitest'
import { stripLeadingTitle } from '../src/utils/leadingTitle'

const TITLE = 'Register the HOLLAR PSM as a HOLLAR facilitator'

describe('stripLeadingTitle', () => {
  it('drops a leading markdown heading that repeats the title', () => {
    expect(stripLeadingTitle(`# ${TITLE}\n\nThis proposal, if approved…`, 'markdown', TITLE)).toBe('This proposal, if approved…')
    expect(stripLeadingTitle(`## **${TITLE}** ##\nBody`, 'markdown', TITLE)).toBe('Body')
    expect(stripLeadingTitle(`\n${TITLE.toUpperCase()}\n===\n\nBody`, 'markdown', TITLE)).toBe('Body')
  })

  it('drops a leading html heading that repeats the title', () => {
    expect(stripLeadingTitle(`<h1><strong>${TITLE}</strong></h1><p>Body</p>`, 'html', TITLE)).toBe('<p>Body</p>')
  })

  it('keeps a heading that says something else, and any later heading', () => {
    const other = '# Summary\n\nBody'
    expect(stripLeadingTitle(other, 'markdown', TITLE)).toBe(other)
    const later = `Intro\n\n# ${TITLE}`
    expect(stripLeadingTitle(later, 'markdown', TITLE)).toBe(later)
    expect(stripLeadingTitle(`# ${TITLE}`, 'markdown', null)).toBe(`# ${TITLE}`)
  })

  it('never reads a list or a rule as a setext heading of the title', () => {
    const body = `${TITLE}\n- one`
    expect(stripLeadingTitle(body, 'markdown', 'Something else')).toBe(body)
  })
})
