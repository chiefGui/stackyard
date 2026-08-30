import { service } from "stackyard";

// @ts-expect-error A service command requires an executable.
service({ command: [] });
