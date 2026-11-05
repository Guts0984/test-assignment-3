import { Suspense } from "react";
import { AuthForm } from "@/features/auth";

export const metadata = { title: "Create an account" };

async function Form({ searchParams }: PageProps<"/register">) {
  const { next } = await searchParams;
  return <AuthForm mode="register" next={typeof next === "string" ? next : undefined} />;
}

export default function RegisterPage(props: PageProps<"/register">) {
  return (
    <main className="px-4 py-12">
      <Suspense fallback={null}>
        <Form {...props} />
      </Suspense>
    </main>
  );
}
