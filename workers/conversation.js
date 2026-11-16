// @ts-check
/**
 * The conversation as the model is given it: what a turn leaves in history, what an
 * interruption leaves there, and what survives when a long conversation is trimmed.
 * Kept apart from the worker so it can be tested without a GPU.
 */

/**
 * Asked in text, silently, when the history is about to be trimmed. Her answer is kept
 * as the latest thing said, so what she was told early on outlives the turns that held it.
 */
export const RECAP_REQUEST =
  "Before we go on: list what I've told you about myself so far, such as my name, where I live, my work, the people and pets in my life, and what I like. Only what I actually said, in a few short sentences.";

/**
 * How long she has now been silent, in samples, after this chunk of her speech.
 * @param {number} quiet the same count before this chunk
 * @param {Float32Array} samples
 * @param {number} [floor] anything quieter is silence
 */
export function quietAfter(quiet, samples, floor = 0.01) {
  let last = samples.length - 1;
  while (last >= 0 && Math.abs(samples[last]) <= floor) last -= 1;
  return last < 0 ? quiet + samples.length : samples.length - 1 - last;
}

/** A reply the listener cut short, as history keeps it: what they heard, visibly unfinished. */
export function cutShort(heard) {
  const text = heard.replace(/[\s.,;:!?…—-]+$/, "");
  return text ? `${text}...` : "";
}

/** The reply as history keeps it: what she said, not the sound of it. */
export function textOnly(message) {
  if (!Array.isArray(message.content)) return message;
  return { ...message, content: message.content.filter((c) => c.type === "text").map((c) => c.text).join("") };
}

export class Conversation {
  constructor() {
    /** @type {any[]} */
    this.history = [];
    /** The latest reply, by turn: the only one an interruption can still shorten. */
    this._last = /** @type {{ id: number, reply: any } | null} */ (null);
    /** What was heard of a reply that hasn't landed in history yet. */
    this._heard = /** @type {{ id: number, text: string } | null} */ (null);
  }

  clear() {
    this.history = [];
    this._last = null;
    this._heard = null;
  }

  /** @param {Float32Array} audio a user turn, 16 kHz */
  addUser(audio) {
    this.history.push({ role: "user", content: [{ type: "audio", audio }] });
  }

  /**
   * Her reply to turn `id`. If the listener cut in while it was still being generated,
   * history keeps what they heard and not what the model had got to.
   * @param {number} id @param {any} message
   */
  addReply(id, message) {
    const reply = textOnly(message);
    if (this._heard?.id === id) reply.content = cutShort(this._heard.text);
    this._heard = null;
    this.history.push(reply);
    this._last = { id, reply };
  }

  /**
   * The listener cut in on turn `id` having heard this much of it. Generation runs several
   * times faster than speech, so the rest was produced but never said.
   * @param {number} id @param {string} text
   */
  heard(id, text) {
    if (this._last?.id !== id) this._heard = { id, text };
    else if (text.length < this._last.reply.content.length) this._last.reply.content = cutShort(text); // all of it heard: nothing to change
  }

  /**
   * Something changed while they were talking (her glasses came off, say). Her earlier
   * replies still say otherwise, and they outweigh the system prompt, so the change is
   * also noted here, where it happened. Nothing to note in a conversation not yet begun.
   * @param {string} text
   */
  note(text) {
    if (this.history.length) this.history.push({ role: "user", content: text });
  }

  get exchanges() {
    return this.history.filter((m) => m.role === "user").length;
  }

  /** Forget the oldest user turn and everything answering it. */
  dropOldestExchange() {
    const next = this.history.findIndex((m, i) => i > 0 && m.role === "user");
    if (next < 0) return false;
    this.history.splice(0, next);
    return true;
  }

  /**
   * Past the budget half the history goes at once, so the next turn's one re-prefill buys
   * many cheap turns. `recap` is her own answer to RECAP_REQUEST, given with the whole
   * history still in view. It is kept as the most recent exchange, not the oldest: placed
   * first it sat a whole trimmed history away, and in a long conversation that had fallen
   * into a pattern she no longer drew on it. By the next trim it is half a history back,
   * and a new recap is made with it in view.
   * @param {string | null} [recap]
   */
  compact(recap = null) {
    const drop = Math.floor(this.exchanges / 2);
    for (let i = 0; i < drop; i++) this.dropOldestExchange();
    if (recap) this.history.push({ role: "user", content: RECAP_REQUEST }, { role: "assistant", content: recap });
  }
}
