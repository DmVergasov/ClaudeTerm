# Ask Claude on a Heads up card — design

## Why

A Heads up card tells the person something they should know while Claude works. Often the next thing they want is to
ask Claude about it, or tell Claude what to do about it. Today they have to copy the card into the message box. The card
gets its own message field and an **Ask Claude** button, always there, that sends the person's words, with the card
attached, to the conversation.

## Goals

- Every card shows a message field ("Ask Claude about this…") and an **Ask Claude** button, beside Explain more, Not
  relevant and Got it, before and after Explain more.
- Ask Claude sends one message to the chat's main conversation: the person's text, then the card quoted (its tag and
  title, its text, and its longer explanation when Explain more brought one), so Claude knows what it is about. The main
  Claude answers in the chat, with its full context and tools.
- A turn under way does not stop: the message queues as any message the person sends while Claude works.
- The card closes once the message is sent, as Got it closes it. Its topic stays offered, so it is not offered again.

## Non-goals

- An answer on the card itself (that is Explain more, from the side agent).
- Attachments in the card's field.
- Remote tabs: Heads up runs for local chats only, as today.

## Approaches

1. **To the main conversation (chosen by the person).** The main Claude has the whole conversation and its tools, so it
   can act on the card at once.
2. To the side agent, the answer on the card, like Explain more. It never disturbs the main work, but the side agent has
   no tools and reads only part of the conversation: it can explain, not fix. Rejected.

## Design

- **Window.** `HeadsUpView` gets a field and an **Ask Claude** button in its own row under the card's text. Enter sends,
  Shift+Enter starts a new line; the button is off while the field is blank. The card's element is rebuilt on every
  change today (`show`), so the field is made once and kept across rebuilds: text the person typed survives Explain more
  and any other update of the same card. A new card starts with an empty field.
- **Main builds the message.** The window sends only the card's id and the person's text (new IPC
  `chatHeadsUpAsk(tabId, cardId, text): Promise<string | null>`, an error text or null). Main checks the tab is a local
  Claude tab, the id a chat ref, the text not blank and within the chat's send cap (`SEND_TEXT_CAP`). `HeadsUp.ask`
  builds the message from main's own card, sends it through the chat's normal send path (`chatHub.send`, no `from`: the
  words are the person's), and closes the card. A card the tab does not show any more is refused, as `act` refuses it.
- **The message.**

  ```
  <the person's text>

  > Heads up: <title>
  >
  > <the card's text, each line quoted>
  >
  > <the longer explanation, each line quoted, when there is one>
  ```

  The tag reads `Heads up` or `You should know`, as on the card.

## Tests

- Unit (`tests/unit/heads-up.test.ts`): `ask` sends the message above (with and without the explanation), closes the
  card, and refuses a card the tab does not show or blank text.
- End-to-end (`tests/e2e/chat-heads-up.spec.ts`): type in the card's field and click Ask Claude, then Enter for a second
  card: the conversation gets the message with the card quoted, the card closes. Text typed before Explain more is still
  in the field after the explanation comes.

## Left to the builder

The field's look (one line growing to a few, like the message box), the exact class names, and the guard's name.
