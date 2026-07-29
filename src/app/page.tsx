import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export default async function Home() {
  // If authenticated → dashboard; otherwise middleware will bounce protected
  // routes to /login. The root itself is not protected so we redirect here
  // based on session state.
  const session = await auth();
  redirect(session ? "/dashboard" : "/login");
}
