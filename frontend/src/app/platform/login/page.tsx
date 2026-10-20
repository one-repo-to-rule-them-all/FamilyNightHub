import type { Metadata } from "next";

import { PhoneScreen } from "@/components/phone-screen";

import { PlatformLoginForm } from "./platform-login-form";

export const metadata: Metadata = { title: "Platform sign-in" };

export default function PlatformLoginPage() {
  return (
    <PhoneScreen
      title="Platform"
      lede="For the person who runs Family Night. Sign in again even if you're signed in to your family."
    >
      <PlatformLoginForm />
    </PhoneScreen>
  );
}
