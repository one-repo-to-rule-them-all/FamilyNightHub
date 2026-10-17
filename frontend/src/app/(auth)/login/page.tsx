import type { Metadata } from "next";

import { PhoneScreen } from "@/components/phone-screen";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <PhoneScreen title="Sign in" lede="For the family admin and hosts.">
      <LoginForm />
    </PhoneScreen>
  );
}
