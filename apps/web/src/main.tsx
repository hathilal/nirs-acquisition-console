
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { supabase } from "./lib/supabase";
import "./styles.css";

async function startApp() {
  // Reuse an existing session if one is available.
  const { data: sessionData, error: sessionError } =
    await supabase.auth.getSession();

  if (sessionError) {
    console.error("Could not check Supabase session:", sessionError.message);
  }

  // Create an anonymous user only when no session exists.
  if (!sessionData.session) {
    const { error } = await supabase.auth.signInAnonymously();

    if (error) {
      console.error("Anonymous sign-in failed:", error.message);
    }
  }

  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

startApp();
