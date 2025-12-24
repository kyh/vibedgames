"use client";

import type { ComponentProps, HTMLAttributes } from "react";
import type { BundledLanguage, ShikiTransformer } from "shiki";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { codeToHtml } from "shiki";

import { Button } from "./button";
import { cn } from "./utils";

export const extensionToLanguageMap: Record<string, BundledLanguage> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  json: "json",
  css: "css",
  html: "html",
  md: "markdown",
  py: "python",
  java: "java",
  c: "c",
  cpp: "cpp",
  cs: "csharp",
  go: "go",
  rs: "rust",
  php: "php",
  rb: "ruby",
  swift: "swift",
  kt: "kotlin",
  scala: "scala",
  sh: "bash",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  sql: "sql",
  vue: "vue",
  svelte: "svelte",
  graphql: "graphql",
  diff: "diff",
  dockerfile: "dockerfile",
  txt: "plaintext" as BundledLanguage,
};

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: BundledLanguage;
  showLineNumbers?: boolean;
  containerClassName?: string;
  preClassName?: string;
};

type CodeBlockContextType = {
  code: string;
};

const CodeBlockContext = createContext<CodeBlockContextType>({
  code: "",
});

const lineNumberTransformer: ShikiTransformer = {
  name: "line-numbers",
  line(node, line) {
    node.children.unshift({
      type: "element",
      tagName: "span",
      properties: {
        className: [
          "inline-block",
          "min-w-10",
          "mr-4",
          "text-right",
          "select-none",
          "text-muted-foreground",
        ],
      },
      children: [{ type: "text", value: String(line) }],
    });
  },
};

export async function highlightCode(
  code: string,
  language: BundledLanguage,
  showLineNumbers = false,
) {
  const transformers: ShikiTransformer[] = showLineNumbers
    ? [lineNumberTransformer]
    : [];

  return await Promise.all([
    codeToHtml(code, {
      lang: language,
      theme: "one-light",
      transformers,
    }),
    codeToHtml(code, {
      lang: language,
      theme: "one-dark-pro",
      transformers,
    }),
  ]);
}

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  className,
  containerClassName,
  preClassName,
  children,
  ...props
}: CodeBlockProps) => {
  const [html, setHtml] = useState<string>("");
  const [darkHtml, setDarkHtml] = useState<string>("");
  const mounted = useRef(false);

  useEffect(() => {
    void highlightCode(code, language, showLineNumbers).then(
      ([light, dark]) => {
        if (!mounted.current) {
          setHtml(light);
          setDarkHtml(dark);
          mounted.current = true;
        }
      },
    );

    return () => {
      mounted.current = false;
    };
  }, [code, language, showLineNumbers]);

  return (
    <CodeBlockContext.Provider value={{ code }}>
      <div
        className={cn(
          "group bg-background text-foreground relative w-full overflow-hidden rounded-md border",
          containerClassName ?? className,
        )}
        {...props}
      >
        <div className="relative">
          <div
            className={cn(
              "[&>pre]:bg-background! [&>pre]:text-foreground! overflow-auto dark:hidden [&_code]:font-mono [&_code]:text-sm [&>pre]:m-0 [&>pre]:text-sm",
              preClassName ?? "[&>pre]:p-4",
            )}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: "this is needed."
            dangerouslySetInnerHTML={{ __html: html }}
          />
          <div
            className={cn(
              "[&>pre]:bg-background! [&>pre]:text-foreground! hidden overflow-auto dark:block [&_code]:font-mono [&_code]:text-sm [&>pre]:m-0 [&>pre]:text-sm",
              preClassName ?? "[&>pre]:p-4",
            )}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: "this is needed."
            dangerouslySetInnerHTML={{ __html: darkHtml }}
          />
          {children && (
            <div className="absolute top-2 right-2 flex items-center gap-2">
              {children}
            </div>
          )}
        </div>
      </div>
    </CodeBlockContext.Provider>
  );
};

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

export const CodeBlockCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  code: codeProp,
  ...props
}: CodeBlockCopyButtonProps & { code?: string }) => {
  const [isCopied, setIsCopied] = useState(false);
  const contextCode = useContext(CodeBlockContext).code;
  const code = codeProp ?? contextCode;

  const copyToClipboard = async () => {
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    try {
      await navigator.clipboard.writeText(code);
      setIsCopied(true);
      onCopy?.();
      setTimeout(() => setIsCopied(false), timeout);
    } catch (error) {
      onError?.(error as Error);
    }
  };

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Button
      className={cn("shrink-0", className)}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon size={14} />}
    </Button>
  );
};
