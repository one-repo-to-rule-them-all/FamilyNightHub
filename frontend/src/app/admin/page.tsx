import { redirect } from "next/navigation";

/** No dashboard yet: the library is the first admin screen. */
export default function AdminIndex() {
  redirect("/admin/movies");
}
