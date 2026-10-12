/**
 * PromptInput - natural-language textarea with an example prompt placeholder.
 */

export class PromptInput {
  /**
   * @param {HTMLElement} container
   */
  constructor(container) {
    this.container = container;
    this.container.classList.add("prompt-input");
    this.container.innerHTML = `
      <label class="panel-title" for="prompt-textarea">Prompt</label>
      <textarea
        id="prompt-textarea"
        rows="3"
        placeholder="Create a modern product announcement for our new AI assistant..."
      ></textarea>
    `;
    this.textarea = this.container.querySelector("#prompt-textarea");
  }

  get value() {
    return this.textarea.value.trim();
  }

  set value(text) {
    this.textarea.value = text;
  }

  focus() {
    this.textarea.focus();
  }
}