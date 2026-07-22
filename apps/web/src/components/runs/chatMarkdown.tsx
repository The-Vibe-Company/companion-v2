"use client";

import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "../Icon";
import { copyRunText } from "./clipboard";

function plainText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(plainText).join("");
  if (value && typeof value === "object" && "props" in value) {
    return plainText((value as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 1_600);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const child = Array.isArray(children) ? children[0] : children;
  const className = child && typeof child === "object" && "props" in child
    ? String((child as { props?: { className?: string } }).props?.className ?? "")
    : "";
  const language = className.match(/language-([^\s]+)/)?.[1] ?? "text";
  const source = plainText(children).replace(/\n$/, "");

  return (
    <div className="run-md__code">
      <div className="run-md__code-head">
        <span>{language}</span>
        <button
          type="button"
          onClick={() => {
            void copyRunText(source).then((copied) => setCopyState(copied ? "copied" : "error"));
          }}
          aria-label={copyState === "copied" ? "Code copied" : copyState === "error" ? "Code copy failed" : "Copy code"}
        >
          <Icon name={copyState === "copied" ? "check" : copyState === "error" ? "alert-triangle" : "copy"} size={12} />
          {copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

const STREAM_MARKDOWN_INTERVAL_MS = 80;

function useStreamingMarkdownText(text: string, streaming: boolean): string {
  const [renderedText, setRenderedText] = useState(text);
  const latestText = useRef(text);
  const lastCommitAt = useRef(Date.now());
  latestText.current = text;

  useEffect(() => {
    if (!streaming || text === renderedText) return;
    const delay = Math.max(0, STREAM_MARKDOWN_INTERVAL_MS - (Date.now() - lastCommitAt.current));
    const timer = window.setTimeout(() => {
      lastCommitAt.current = Date.now();
      setRenderedText(latestText.current);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [renderedText, streaming, text]);

  // The final delta is never delayed once the server closes the message.
  return streaming ? renderedText : text;
}

/** Parsing is isolated so parent/delta renders with the same throttled text are effectively free. */
const ParsedMarkdown = memo(function ParsedMarkdown({
  text,
  artifactPaths,
  onOpenArtifact,
}: {
  text: string;
  artifactPaths: Record<string, string>;
  onOpenArtifact?: (artifactId: string) => void;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) => defaultUrlTransform(url)}
      components={{
        pre: CodeBlock,
        a: ({ href, children, ...props }) => {
          const artifactId = href ? artifactPaths[href] : undefined;
          if (artifactId && onOpenArtifact) {
            return <button type="button" className="run-artifact-link" onClick={() => onOpenArtifact(artifactId)}>{children}</button>;
          }
          const external = Boolean(href && /^https?:\/\//i.test(href));
          return (
            <a
              {...props}
              href={href}
              target={external ? "_blank" : undefined}
              rel={external ? "noreferrer noopener" : undefined}
            >
              {children}
            </a>
          );
        },
        // Agent output is untrusted. Never let Markdown silently beacon to a remote image host;
        // verified run images and videos are rendered through the authenticated media pipeline.
        img: ({ alt }) => (
          <span className="run-md__image-placeholder" role="note">
            <Icon name="image" size={13} />
            Image not loaded{alt ? ` · ${alt}` : ""}
          </span>
        ),
        code: ({ className, children, ...props }) => {
          const value = plainText(children).trim();
          const artifactId = !className && !value.includes("\n") ? artifactPaths[value] : undefined;
          return artifactId && onOpenArtifact
            ? <button type="button" className="run-artifact-link run-artifact-link--code" onClick={() => onOpenArtifact(artifactId)}>{value}</button>
            : <code className={className} {...props}>{children}</code>;
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

/** Full GFM rendering for assistant output. Raw HTML stays escaped by react-markdown. */
export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  streaming = false,
  artifactPaths = {},
  onOpenArtifact,
}: {
  text: string;
  streaming?: boolean;
  artifactPaths?: Record<string, string>;
  onOpenArtifact?: (artifactId: string) => void;
}) {
  const renderedText = useStreamingMarkdownText(text, streaming);
  return (
    <div className="run-md">
      <ParsedMarkdown text={renderedText} artifactPaths={artifactPaths} onOpenArtifact={onOpenArtifact} />
      {streaming ? <span className="chat-caret" aria-hidden="true" /> : null}
    </div>
  );
});
