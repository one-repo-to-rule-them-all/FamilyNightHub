import type { Metadata } from "next";

import { PhoneScreen } from "@/components/phone-screen";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Host sign in" };

export default function LoginPage() {
  return (
    <PhoneScreen title="Host sign in" lede="We'll email you a sign-in link. No password needed.">
      <LoginForm />
    </PhoneScreen>
  );
}
