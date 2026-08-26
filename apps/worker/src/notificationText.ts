const NOTIFICATION_BODY_LIMIT = 180;
const EMPTY_NOTIFICATION_BODY = "Open the conversation for details.";

function stripFencedCode(markdown: string): string {
  return markdown
    .replace(
      /(`{3,}|~{3,})([A-Za-z0-9_+#.-]+)?(?:[^\S\r\n]*\r?\n|[ \t]+)([\s\S]*?)\1/g,
      "$3",
    )
    .replace(/(^|\s)(`{3,}|~{3,})[A-Za-z0-9_+#.-]+(?=\s|$)/g, "$1")
    .replace(/`{3,}|~{3,}/g, "");
}

function stripLinks(markdown: string): string {
  return markdown
    .replace(/^ {0,3}\[[^\]]+\]:\s+\S+.*$/gm, "")
    .replace(/!\[([^\]]*)\]\((?:\\.|[^)])*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:\\.|[^)])*\)/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*$/g, "$1")
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/gi, "$1")
    .replace(/!\[([^\]]*)\](?:\[[^\]]*\])?/g, "$1")
    .replace(/\[([^\]]+)\](?:\[[^\]]*\])?/g, "$1");
}

function stripInlineMarkup(markdown: string): string {
  let text = markdown;
  for (let pass = 0; pass < 2; pass += 1) {
    text = text
      .replace(/\*\*([\s\S]*?)\*\*/g, "$1")
      .replace(/__([\s\S]*?)__/g, "$1")
      .replace(/~~([\s\S]*?)~~/g, "$1")
      .replace(/\*([^*\n]+)\*/g, "$1")
      .replace(/(^|[\s([{])_([^_\n]+)_(?=$|[\s)\]},.!?:;])/g, "$1$2");
  }
  return text
    .replace(/\*+/g, "")
    .replace(/(^|[\s([{])_+(?=\S)/g, "$1")
    .replace(/(\S)_+(?=$|[\s)\]},.!?:;])/g, "$1")
    .replace(/~{2,}/g, "")
    .replace(/`+/g, "")
    .replace(/[[\]]/g, "");
}

function truncatePlainText(text: string): string {
  const characters = Array.from(text);
  if (characters.length <= NOTIFICATION_BODY_LIMIT) return text;
  return `${characters.slice(0, NOTIFICATION_BODY_LIMIT - 1).join("").trimEnd()}…`;
}

export function plainTextNotificationBody(markdown: string): string {
  const blocks = stripFencedCode(markdown.replace(/\r\n?/g, "\n"))
    .replace(/^ {0,3}(?:={3,}|-{3,}|_{3,}|\*{3,})\s*$/gm, "")
    .replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/gm, "")
    .replace(/(^|\s)#{1,6}(?=\s)/g, "$1")
    .replace(/[ \t]+#{1,6}\s*$/gm, "")
    .replace(/(^|\s)>+[ \t]*/g, "$1")
    .replace(/(^|\s)\[[xX]\][ \t]+/g, "$1✓ ")
    .replace(/(^|\s)\[ \][ \t]+/g, "$1○ ")
    .replace(/(^|\s)[-+*][ \t]+(?=\S)/g, "$1• ")
    .replace(/(^|\s)(\d+)[.)][ \t]+/g, "$1$2. ");
  const inlineCode = blocks
    .replace(/(`+)([\s\S]*?)\1/g, "$2")
    .replace(/\\([\\`*{}[\]()#+.!_>~-])/g, "$1");
  const plain = stripInlineMarkup(stripLinks(inlineCode))
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return truncatePlainText(plain || EMPTY_NOTIFICATION_BODY);
}
