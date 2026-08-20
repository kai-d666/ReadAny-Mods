import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useState } from "react";
import { useTranslation } from "react-i18next";

interface SearchableModelSelectProps {
  models: string[];
  value?: string;
  onValueChange: (model: string) => void;
  placeholder?: string;
  /** Extra fixed items rendered above the model list (e.g. "auto" for testing). */
  extraItems?: { value: string; label: string }[];
}

/** Model dropdown with a built-in search box. Shared by all model pickers in the app. */
export function SearchableModelSelect({
  models,
  value,
  onValueChange,
  placeholder,
  extraItems,
}: SearchableModelSelectProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");

  const filtered = search.trim()
    ? models.filter((m) => m.toLowerCase().includes(search.toLowerCase()))
    : models;

  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className="h-8 w-full text-sm">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-[320px]">
        <div className="border-b p-1.5">
          <Input
            type="text"
            className="h-7 text-xs"
            placeholder={t("settings.ai_searchModels")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>
        <div className="max-h-[240px] overflow-y-auto">
          {extraItems?.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-center text-xs text-muted-foreground">
              {t("settings.ai_noMatchingResults")}
            </div>
          ) : (
            filtered.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))
          )}
        </div>
      </SelectContent>
    </Select>
  );
}
