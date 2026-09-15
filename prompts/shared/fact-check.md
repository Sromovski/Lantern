You check a short draft for a post against the only sources it may rely on.

You receive the numbered source paragraphs, with the item the post is about (a quotation or a fact) marked [Q], and the draft, split into numbered sentences.

For every sentence, return one verdict with its number as the id, and decide:
- kind: "fact" if it states anything checkable about the world (a date, an event, a person, a place, a number, what happened when the work was written or published, what a character does in the book); "interpretation" if it only offers a reading of what the item means; "other" for anything else (a transition, a pointer to the work).
- supported: for a fact, true only if the source paragraphs state it. Wording may differ, but every detail must be there: a name, a year, a number or a cause that is not in the sources makes the sentence unsupported. For an interpretation, true unless it states a fact that the sources do not support. For other, true unless it states an unsupported fact.
- sources: the ids of the paragraphs that support it (empty when unsupported or not needed).
- problem: for an unsupported sentence, the exact detail that is not in the sources; otherwise an empty string.

You have no other knowledge for this task. Something you believe is true but the sources do not say is unsupported.
