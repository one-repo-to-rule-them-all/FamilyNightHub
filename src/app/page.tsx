import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function Home() {
  const supabase = await createClient();
  const { data: nights, error } = await supabase
    .from("family_nights")
    .select("id, title, scheduled_for")
    .order("scheduled_for", { ascending: true })
    .limit(5);

  return (
    <main>
      <h1>Family Night Hub</h1>
      {error ? (
        <p>Supabase not reachable yet: {error.message}</p>
      ) : nights?.length ? (
        <ul>
          {nights.map((n) => (
            <li key={n.id}>
              {n.title} - {new Date(n.scheduled_for).toLocaleString()}
            </li>
          ))}
        </ul>
      ) : (
        <p>No family nights yet. Sign in and create one!</p>
      )}
    </main>
  );
}
