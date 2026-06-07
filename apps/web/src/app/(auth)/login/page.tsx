import { redirect } from "next/navigation";
import { LoginForm } from "./LoginForm";
import { getServerSupabase } from "@/lib/supabase/server";

export default async function LoginPage() {
  const supabase = await getServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/skills");

  return <LoginForm />;
}
