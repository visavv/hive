/** The only bridge the renderer gets: send a line, receive lines. */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("hiveBridge", {
  send: (line: string) => ipcRenderer.send("hive:send", line),
  onMessage: (fn: (line: string) => void) => {
    ipcRenderer.on("hive:msg", (_e, line: string) => fn(line));
  },
  onFocusLast: (fn: () => void) => {
    ipcRenderer.on("hive:focus-last", () => fn());
  },
  hello: (): Promise<string | null> => ipcRenderer.invoke("hive:hello"),
});
