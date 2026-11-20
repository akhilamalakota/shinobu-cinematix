
import { Box, Text, useInput, useStdin } from "ink";
import { UpdateBanner } from "../components/UpdateBanner";
import { TextField } from "../components/TextField";
import { Panel } from "../components/Panel";
import { LOGO_LINES, LOGO_WIDTH } from "../logo";
import { useStore } from "../store";
import { sourcesByGroup } from "../../sources/registry";
import { COLOR, ICON, lerpHex } from "../theme";

const CATEGORIES = sourcesByGroup()
  .map((g) => g.group.toLowerCase())
  .join(`  ${ICON.dot}  `);

const HIGHLIGHT = "#FFFFFF";
const TOP = "#FF667F";
const BASE = COLOR.accent;
const SHADE = "#FF3355";

function getSheen(t: number): string {
  if (t < 0.12) return lerpHex(HIGHLIGHT, TOP, t / 0.12);
  if (t < 0.4) return lerpHex(TOP, COLOR.bright, (t - 0.12) / 0.28);
  if (t < 0.72) return lerpHex(COLOR.bright, BASE, (t - 0.4) / 0.32);
  return lerpHex(BASE, SHADE, (t - 0.72) / 0.28);
}

function EntranceLogo() {
  const rows = LOGO_LINES.length;

  return (
    <Box flexDirection="column" alignItems="center">
      {LOGO_LINES.map((line, row) => {
        const textRow = Math.max(0, row - 1);
        const textRows = Math.max(1, rows - 1);
        const tY = textRow / (textRows - 1 || 1);
        const chars = [...line];
        const last = Math.max(1, chars.length - 1);

        return (
          <Box key={row}>
            {chars.map((ch, i) => {
              if (ch === " ") return <Text key={i}> </Text>;

              const tX = i / last;
              const factor = (tX + tY) / 2;

              return (
                <Text key={i} bold color={getSheen(factor)}>
                  {ch}
                </Text>
              );
            })}
          </Box>
        );
      })}
    </Box>
  );
}

export function Splash({
  updateVersion,
  recovered,
}: { updateVersion?: string | null; recovered?: boolean } = {}) {
  const { submitQuery, quitAll, cols, rows } = useStore();
  const { isRawModeSupported } = useStdin();

  useInput(
    (input, key) => {
      if (key.escape || (key.ctrl && input === "c")) quitAll();
    },
    { isActive: isRawModeSupported },
  );

  const showLogo = cols >= LOGO_WIDTH + 2;
  const barWidth = Math.max(24, Math.min(cols - 6, 62));

  return (
    <Box
      height={Math.max(1, rows - 1)}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      <UpdateBanner latest={updateVersion ?? null} />

      {recovered ? (
        <Text dimColor>
          {"↻ recovered from a crashed start · downloads paused"}
        </Text>
      ) : null}

      <Box marginBottom={1}>
        <Text color="#FF3355" bold>
          THE SHINOBU UNIVERSE PRESENTS
        </Text>
      </Box>

      {showLogo ? (
        <EntranceLogo />
      ) : (
        <Box flexDirection="column" alignItems="center">
          <Text bold color={COLOR.accent}>SHINOBU</Text>
          <Text bold color={COLOR.bright}>CINEMATIX</Text>
        </Box>
      )}

      <Box marginTop={1} width={barWidth}>
        <Panel title="Search" width={barWidth} focused height={2}>
          <Box>
            <Text color={COLOR.accent} bold>{`${ICON.pointer} `}</Text>
            <Box flexGrow={1} minWidth={0}>
              <TextField
                placeholder="Search, paste a magnet, or drop a .torrent…"
                width={Math.max(1, barWidth - 6)}
                onSubmit={submitQuery}
                onExitDown={() => submitQuery("")}
              />
            </Box>
          </Box>
        </Panel>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>{CATEGORIES}</Text>
      </Box>

      <Box marginTop={1}>
        <Text>
          <Text color={COLOR.alt}>↵</Text>
          <Text dimColor> search</Text>
          <Text dimColor>{`  ${ICON.dot}  `}</Text>
          <Text color={COLOR.alt}>⇥</Text>
          <Text dimColor> browse</Text>
          <Text dimColor>{`  ${ICON.dot}  `}</Text>
          <Text color={COLOR.alt}>^c</Text>
          <Text dimColor> quit</Text>
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text color="#FFFFFF" bold>AKHIL AMALAKOTA</Text>
        <Text color="#FF3355" bold> · FOUNDER OF SHINOBU</Text>
      </Box>
    </Box>
  );
}
