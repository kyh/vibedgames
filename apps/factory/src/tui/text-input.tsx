import { Box, Text, useInput, usePaste } from "ink";
import type { Key } from "ink";
import { useState } from "react";

import { color } from "./theme.ts";

const FOCUSED_BG = "#232333";

interface Row {
  start: number;
  text: string;
  /** The last row of a hard line: the cursor may sit just past its end. */
  endsLine: boolean;
}

/** Hard lines split into rows of at most `width` columns, with their offsets. */
const layoutRows = (value: string, width: number): Row[] => {
  const rows: Row[] = [];
  let offset = 0;
  for (const line of value.split("\n")) {
    if (line.length === 0) {
      rows.push({ endsLine: true, start: offset, text: "" });
    }
    for (let at = 0; at < line.length; at += width) {
      const text = line.slice(at, at + width);
      rows.push({ endsLine: at + width >= line.length, start: offset + at, text });
    }
    offset += line.length + 1;
  }
  return rows;
};

const cursorRow = (rows: Row[], cursor: number): number => {
  const index = rows.findIndex(
    (row) =>
      cursor >= row.start &&
      (cursor < row.start + row.text.length ||
        (row.endsLine && cursor === row.start + row.text.length)),
  );
  return Math.max(0, index);
};

/** The cursor's index after a navigation key, or null when `key` is not one. */
const navigate = (input: string, key: Key, value: string, cursor: number): number | null => {
  if (key.leftArrow) {
    return Math.max(0, cursor - 1);
  }
  if (key.rightArrow) {
    return Math.min(value.length, cursor + 1);
  }
  if (key.home || (key.ctrl && input === "a")) {
    return value.lastIndexOf("\n", cursor - 1) + 1;
  }
  if (key.end || (key.ctrl && input === "e")) {
    const lineEnd = value.indexOf("\n", cursor);
    return lineEnd === -1 ? value.length : lineEnd;
  }
  return null;
};

/** Keys the enclosing screen owns; they never type into the field. */
const isScreenKey = (key: Key): boolean =>
  key.ctrl ||
  key.meta ||
  key.tab ||
  key.escape ||
  key.upArrow ||
  key.downArrow ||
  key.pageUp ||
  key.pageDown;

interface RowViewProps {
  text: string;
  /** Column of the cursor on this row, or null when it is elsewhere. */
  cursorCol: number | null;
}

const RowView = ({ text, cursorCol }: RowViewProps) => {
  if (cursorCol === null) {
    return <Text color={color.text}>{text || " "}</Text>;
  }
  return (
    <Text color={color.text}>
      {text.slice(0, cursorCol)}
      <Text backgroundColor={color.accent} color={color.bg}>
        {text[cursorCol] ?? " "}
      </Text>
      {text.slice(cursorCol + 1)}
    </Text>
  );
};

export interface TextInputProps {
  value: string;
  placeholder: string;
  focused: boolean;
  /** Content columns, so long values scroll or wrap instead of overflowing. */
  width: number;
  /** Rows shown; above 1, ENTER inserts a newline instead of submitting. */
  rows?: number;
  onChange: (value: string) => void;
  onSubmit?: () => void;
}

/**
 * A minimal controlled text field. TAB, ESC, and (single-line) up/down are left
 * to the enclosing screen, which owns focus and navigation.
 */
export const TextInput = ({
  value,
  placeholder,
  focused,
  width,
  rows = 1,
  onChange,
  onSubmit,
}: TextInputProps) => {
  const multiline = rows > 1;
  const [cursorIndex, setCursorIndex] = useState(value.length);
  const cursor = Math.min(cursorIndex, value.length);

  const insert = (raw: string): void => {
    const text = multiline
      ? raw.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
      : raw.replaceAll(/[\r\n]+/gu, " ");
    if (!text) {
      return;
    }
    onChange(value.slice(0, cursor) + text + value.slice(cursor));
    setCursorIndex(cursor + text.length);
  };

  useInput(
    (input, key) => {
      const moved = navigate(input, key, value, cursor);
      if (moved !== null) {
        setCursorIndex(moved);
      } else if (key.backspace || key.delete) {
        // Most terminals send DEL for the backspace key, which Ink reports as delete.
        if (cursor > 0) {
          onChange(value.slice(0, cursor - 1) + value.slice(cursor));
          setCursorIndex(cursor - 1);
        }
      } else if (key.return) {
        if (multiline) {
          insert("\n");
        } else {
          onSubmit?.();
        }
      } else if (!isScreenKey(key)) {
        insert(input);
      }
    },
    { isActive: focused },
  );
  usePaste(insert, { isActive: focused });

  const background = focused ? FOCUSED_BG : color.ghost;

  if (!value) {
    return (
      <Box backgroundColor={background} width={width} height={rows} flexDirection="column">
        <Text wrap="truncate-end">
          {focused ? (
            <Text backgroundColor={color.accent} color={color.bg}>
              {placeholder.slice(0, 1) || " "}
            </Text>
          ) : null}
          <Text color={color.faint}>{focused ? placeholder.slice(1) : placeholder}</Text>
        </Text>
      </Box>
    );
  }

  if (!multiline) {
    // Keep the cursor's column in view, with room for it past the last character.
    const start = Math.max(0, cursor - width + 1);
    return (
      <Box backgroundColor={background} width={width}>
        <RowView
          text={value.slice(start, start + width)}
          cursorCol={focused ? cursor - start : null}
        />
      </Box>
    );
  }

  const laidOut = layoutRows(value, width - 1);
  const active = cursorRow(laidOut, cursor);
  const first = Math.max(0, Math.min(active - rows + 1, laidOut.length - rows));
  return (
    <Box backgroundColor={background} width={width} height={rows} flexDirection="column">
      {laidOut.slice(first, first + rows).map((row, i) => (
        <RowView
          key={row.start}
          text={row.text}
          cursorCol={focused && first + i === active ? cursor - row.start : null}
        />
      ))}
    </Box>
  );
};
