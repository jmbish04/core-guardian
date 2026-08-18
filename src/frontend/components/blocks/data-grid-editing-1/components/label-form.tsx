import { useEffect, type CSSProperties } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import * as z from "zod"

import { cn } from "~/lib/utils"
import { Button } from "~/components/ui/button"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "~/components/ui/field"
import { Input } from "~/components/ui/input"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
} from "~/components/ui/item"
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover"

import {
  LABEL_COLOR_OPTIONS,
  LABEL_COLOR_VALUES,
  type LabelColor,
} from "./data"

const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/

const labelFormSchema = z.object({
  title: z
    .string()
    .trim()
    .min(2, "Label title must be at least 2 characters.")
    .max(32, "Label title must be at most 32 characters."),
  color: z
    .string()
    .regex(HEX_COLOR_PATTERN, "Choose or enter a valid hex color."),
})

export type LabelFormValues = z.infer<typeof labelFormSchema>

type LabelFormProps = {
  formId: string
  mode: "create" | "edit"
  defaultValues: LabelFormValues
  onCancel: () => void
  onSubmit: (values: LabelFormValues) => boolean
}

function getColorLabel(color: LabelColor) {
  return (
    LABEL_COLOR_OPTIONS.find((option) => option.value === color)?.label ??
    color.toUpperCase()
  )
}

function normalizeColorValue(color: string) {
  return color.toUpperCase()
}

function LabelColorPicker({
  value,
  invalid,
  onChange,
}: {
  value: LabelColor
  invalid: boolean
  onChange: (value: LabelColor) => void
}) {
  const selectedColor = HEX_COLOR_PATTERN.test(value)
    ? value
    : LABEL_COLOR_VALUES[0]

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="aspect-square"
            aria-label={`Selected color: ${getColorLabel(value)}`}
            aria-invalid={invalid}
          >
            <span
              className="border-border pointer-events-none block size-4.5 rounded-full border shadow-xs"
              style={{ backgroundColor: value }}
              aria-hidden="true"
            />
          </Button>
        }
      />
      <PopoverContent align="start" className="w-52 gap-2.5 p-2.5">
        <PopoverHeader>
          <PopoverTitle>Label color</PopoverTitle>
        </PopoverHeader>

        <div className="grid grid-cols-6 gap-2">
          {LABEL_COLOR_OPTIONS.map((color) => (
            <button
              key={color.value}
              type="button"
              className={cn(
                "size-6 rounded-full border transition outline-none",
                color.value === value && "ring-ring ring-2 ring-offset-1"
              )}
              style={
                {
                  backgroundColor: color.value,
                  "--tw-ring-offset-color": "var(--popover)",
                } as CSSProperties
              }
              aria-label={color.label}
              aria-pressed={color.value === value}
              onClick={() => onChange(normalizeColorValue(color.value))}
            />
          ))}
        </div>

        <label className="border-border bg-background hover:bg-accent hover:text-accent-foreground flex h-8 cursor-pointer items-center gap-1.5 rounded-full border px-2 text-xs transition-colors">
          <span className="border-border relative block size-5 shrink-0 overflow-hidden rounded-full border shadow-xs">
            <span
              className="pointer-events-none absolute inset-0"
              style={{ backgroundColor: selectedColor }}
              aria-hidden="true"
            />
            <Input
              type="color"
              value={selectedColor}
              className="absolute inset-0 h-full! w-full! cursor-pointer border-0! bg-transparent! p-0! opacity-0 shadow-none!"
              aria-label="Choose custom label color"
              onChange={(event) =>
                onChange(normalizeColorValue(event.currentTarget.value))
              }
            />
          </span>
          <span className="text-muted-foreground">Custom</span>
          <span className="text-foreground ml-auto font-mono text-[11px]">
            {normalizeColorValue(selectedColor)}
          </span>
        </label>
      </PopoverContent>
    </Popover>
  )
}

export function LabelForm({
  formId,
  mode,
  defaultValues,
  onCancel,
  onSubmit,
}: LabelFormProps) {
  const form = useForm<LabelFormValues>({
    resolver: zodResolver(labelFormSchema),
    defaultValues,
  })

  useEffect(() => {
    form.reset(defaultValues)
  }, [defaultValues, form])

  function handleSubmit(values: LabelFormValues) {
    const saved = onSubmit({
      ...values,
      title: values.title.trim(),
    })

    if (saved) {
      form.reset(defaultValues)
    }
  }

  return (
    <form id={formId} onSubmit={form.handleSubmit(handleSubmit)}>
      <FieldGroup>
        <Item
          variant="outline"
          size="sm"
          className="items-start sm:flex-nowrap"
        >
          <ItemMedia className="self-start">
            <Controller
              name="color"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field className="shrink-0" data-invalid={fieldState.invalid}>
                  <FieldLabel className="sr-only">Label color</FieldLabel>
                  <LabelColorPicker
                    value={field.value}
                    invalid={fieldState.invalid}
                    onChange={field.onChange}
                  />
                  {fieldState.invalid && (
                    <FieldError errors={[fieldState.error]} />
                  )}
                </Field>
              )}
            />
          </ItemMedia>

          <ItemContent className="min-w-0">
            <Controller
              name="title"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field
                  className="min-w-0 flex-1"
                  data-invalid={fieldState.invalid}
                >
                  <FieldLabel className="sr-only" htmlFor={`${formId}-title`}>
                    Label title
                  </FieldLabel>
                  <Input
                    {...field}
                    id={`${formId}-title`}
                    aria-invalid={fieldState.invalid}
                    placeholder="Label title"
                    autoComplete="off"
                  />
                  {fieldState.invalid && (
                    <FieldError errors={[fieldState.error]} />
                  )}
                </Field>
              )}
            />
          </ItemContent>

          <ItemActions className="w-full justify-end sm:w-auto sm:self-start">
            <Field orientation="horizontal" className="w-auto justify-end">
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button type="submit" form={formId}>
                {mode === "create" ? "Add" : "Save"}
              </Button>
            </Field>
          </ItemActions>
        </Item>
      </FieldGroup>
    </form>
  )
}