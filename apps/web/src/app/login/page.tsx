import { Suspense } from "react";
import { AuthForm } from "@/features/auth";

export const metadata = { title: "Log in" };

async function Form({ searchParams }: PageProps<"/login">) {
  const { next } = await searchParams;
  return <AuthForm mode="login" next={typeof next === "string" ? next : undefined} />;
}

export default function LoginPage(props: PageProps<"/login">) {
  return (
    <main className="px-4 py-12">
      <Suspense fallback={null}>
        <Form {...props} />
      </Suspense>
    </main>
  );
}
