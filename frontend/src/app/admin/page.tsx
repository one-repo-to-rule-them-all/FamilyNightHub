import { redirect } from "next/navigation";

/** `/admin` has no screen of its own: Home is the portal's front door (AC-P0.6). */
export default function AdminHome() {
  redirect("/host");
}
