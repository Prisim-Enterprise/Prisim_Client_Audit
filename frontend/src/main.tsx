import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { ConfigurationError } from "./app/ConfigurationError";
import { Providers } from "./app/Providers";
import { parsePublicEnv } from "./lib/env";
import { createSupabaseBrowserClient } from "./lib/supabase";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("The frontend root element is missing.");

const root = createRoot(rootElement);
const envResult = parsePublicEnv(import.meta.env, import.meta.env.MODE);

if (!envResult.success) {
  root.render(
    <StrictMode>
      <ConfigurationError errors={envResult.errors} />
    </StrictMode>,
  );
} else {
  const supabase = createSupabaseBrowserClient(envResult.data);
  root.render(
    <StrictMode>
      <Providers supabase={supabase} appUrl={envResult.data.appUrl}>
        <App />
      </Providers>
    </StrictMode>,
  );
}
