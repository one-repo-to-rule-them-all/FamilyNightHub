import { redirect } from "next/navigation";

/** `/admin` opens on People. */
export default function AdminHome() {
  redirect("/admin/people");
}
