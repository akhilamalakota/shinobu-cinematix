
import { Box, Text } from "ink";
import { COLOR, RULE } from "../theme";
import type { Hint } from "../keymap";

export function Footer({ hints }: { hints: Hint[] }) {
  return (
    <Box
      borderStyle="single"
      borderTop={true}
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderColor={RULE}
      paddingTop={0}
    >
      <Text wrap="truncate-end">
        <Text color="#FF3355" bold>
          SHINOBU UNIVERSE
        </Text>
        <Text dimColor>{"  ·  "}</Text>
        <Text color="#FFFFFF" bold>
          AKHIL AMALAKOTA
        </Text>
        <Text dimColor>{"  ·  "}</Text>
        {hints.map((h, i) => (
          <Text key={h.keys + h.label}>
            {i > 0 ? <Text dimColor>{"   "}</Text> : null}
            <Text color={COLOR.bright} bold>{h.keys}</Text>
            <Text color={COLOR.alt}>{` ${h.label}`}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}
