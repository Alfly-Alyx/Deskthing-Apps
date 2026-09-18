import { promises as fs } from "fs";
import path from "path";

const loudnessExeSrc = path.resolve(
  "node_modules",
  "loudness",
  "impl",
  "windows",
  "adjust_get_current_system_volume_vista_plus.exe",
);
const loudnessExeDest = path.resolve(
  "dist",
  "server",
  "adjust_get_current_system_volume_vista_plus.exe",
);

const bridgeFiles = [
  "jriverAutomationBridge.ps1",
  "jriverAutomationHost.ps1",
  "mediaMonkeyAutomationHost.ps1",
  "wmpAutomationHost.ps1",
];

export default {
  plugins: [
    {
      name: "copy-windows-audio-files",
      setup(build) {
        build.onEnd(async () => {
          try {
            await fs.copyFile(loudnessExeSrc, loudnessExeDest);
            console.log("Copied loudness .exe to dist/server");
          } catch (err) {
            console.warn("Could not copy loudness .exe:", err.message);
          }

          for (const file of bridgeFiles) {
            try {
              await fs.copyFile(
                path.resolve("server", file),
                path.resolve("dist", "server", file),
              );
              console.log(`Copied ${file} to dist/server`);
            } catch (err) {
              console.warn(`Could not copy ${file}:`, err.message);
            }
          }
        });
      },
    },
  ],
};
