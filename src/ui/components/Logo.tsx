
import { Box, Text } from "ink";
import { COLOR } from "../theme";

export function Logo() {
  return (
    <Box flexDirection="column">
      <Box alignItems="center">
        <Text color={COLOR.bright} bold>影 </Text>
        <Text color={COLOR.text} bold>SHINOBU</Text>
      </Box>
      <Box marginLeft={3}>
        <Text color={COLOR.accent} bold>
          C I N E M A T I X
        </Text>
      </Box>
    </Box>
  );
}
