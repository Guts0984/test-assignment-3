"use client";

import type { EventDto } from "@app/shared";
import { useActionState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { Label } from "@/shared/ui/label";
import { Textarea } from "@/shared/ui/textarea";
import { TextField } from "@/shared/ui/text-field";
import { updateEventAction } from "../actions";
import { initialEditState, type EditEventState } from "../lib/state";

export function EditEventForm({ event }: { event: EventDto }) {
  const [state, formAction, pending] = useActionState<EditEventState, FormData>(updateEventAction, initialEditState);

  // What is saved: the event the page was made with, or what a successful save returned.
  const saved = state.status === "saved" ? state.event : event;
  // After a conflict, the form works from the latest saved version but keeps what the editor typed.
  const base = state.status === "conflict" ? state.current : saved;
  const typed = state.status === "conflict" || state.status === "invalid" || state.status === "failed" ? state.submitted : undefined;
  const fields = state.status === "invalid" ? state.fields : {};
  // A new key makes React start the inputs again from the values below.
  const formKey = `${base.version}:${state.status}`;

  return (
    <div className="space-y-6">
      {state.status === "saved" && (
        <Alert role="status">
          <AlertTitle>Saved</AlertTitle>
          <AlertDescription>
            The event is now at version {state.event.version}. The catalog and the event page show the change.
          </AlertDescription>
        </Alert>
      )}
      {state.status === "conflict" && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Someone else saved this event while you were editing</AlertTitle>
          <AlertDescription>
            <p>Nothing you typed was lost: it is still in the form below. Compare it with what is saved now, then save again.</p>
            <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]" aria-label="What is saved now">
              <dt className="font-medium">Saved title</dt>
              <dd data-testid="saved-title">{state.current.title}</dd>
              <dt className="font-medium">Saved description</dt>
              <dd>{state.current.description}</dd>
              <dt className="font-medium">Saved capacity</dt>
              <dd>{state.current.capacity}</dd>
              <dt className="font-medium">Saved version</dt>
              <dd>{state.current.version}</dd>
            </dl>
          </AlertDescription>
        </Alert>
      )}
      {state.status === "failed" && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      <form action={formAction} key={formKey} className="space-y-4" noValidate>
        <input type="hidden" name="eventId" value={event.id} />
        <input type="hidden" name="version" value={base.version} />
        <TextField id="edit-title" name="title" label="Title" defaultValue={typed?.title ?? base.title} errors={fields["title"]} required />
        <div className="space-y-1.5">
          <Label htmlFor="edit-description">Description</Label>
          <Textarea
            id="edit-description"
            name="description"
            rows={6}
            defaultValue={typed?.description ?? base.description}
            aria-invalid={fields["description"] ? true : undefined}
            aria-describedby={fields["description"] ? "edit-description-error" : undefined}
            required
          />
          {fields["description"] && (
            <p id="edit-description-error" role="alert" className="text-sm text-destructive">
              {fields["description"].join(" ")}
            </p>
          )}
        </div>
        <TextField
          id="edit-capacity"
          name="capacity"
          type="number"
          min={1}
          label="Capacity"
          defaultValue={typed?.capacity ?? String(base.capacity)}
          errors={fields["capacity"]}
          hint="It cannot be lower than the seats already held or confirmed."
          required
        />
        <p className="text-xs text-muted-foreground">Editing version {base.version}</p>
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </form>
    </div>
  );
}
